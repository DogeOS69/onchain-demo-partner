import assert from 'node:assert/strict';

const { SOURCE_COMMIT, KEEPER_REPLICAS = '1' } = process.env;
assert(/^[a-f0-9]{40}$/.test(SOURCE_COMMIT ?? ''), 'Set a full SOURCE_COMMIT');
assert(['0', '1'].includes(KEEPER_REPLICAS), 'Run at most one signing keeper');
const namespace = 'dogeos-randomness-testnet';
const labels = { 'app.kubernetes.io/name': 'dogeos-randomness-testnet' };
const image = 'node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
const bootstrap = `
  const fs = require('node:fs');
  const {execFileSync} = require('node:child_process');
  (async () => {
    const response = await fetch('https://codeload.github.com/DogeOS69/onchain-demo-partner/tar.gz/' + process.env.SOURCE_COMMIT,
      {signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error('Source download: HTTP ' + response.status);
    fs.writeFileSync('/work/source.tar.gz', Buffer.from(await response.arrayBuffer()));
    fs.mkdirSync('/work/source', {recursive:true});
    execFileSync('tar', ['-xzf','/work/source.tar.gz','--strip-components=1','-C','/work/source']);
    execFileSync('npm', ['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund','--cache','/tmp/npm'],
      {cwd:'/work/source/randomness',stdio:'inherit'});
    fs.rmSync('/work/source.tar.gz');
  })().catch(error => {console.error(error.message);process.exit(1)});
`;

const items = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace,
    annotations: { 'dogeos.com/purpose': 'Chikyu testnet AnyRand keeper; separate from the AA bundler' },
    labels: { ...labels, 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'latest' } } },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'keeper', namespace, labels }, spec: {
    replicas: Number(KEEPER_REPLICAS), strategy: { type: 'Recreate' }, revisionHistoryLimit: 3,
    selector: { matchLabels: labels }, template: { metadata: { labels, annotations: { 'dogeos.com/source-commit': SOURCE_COMMIT } }, spec: {
      automountServiceAccountToken: false, terminationGracePeriodSeconds: 240,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      initContainers: [{ name: 'prepare-code', image, command: ['node', '-e', bootstrap], securityContext,
        env: [{ name: 'SOURCE_COMMIT', value: SOURCE_COMMIT }],
        resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '1', memory: '1Gi' } },
        volumeMounts: [{ name: 'code', mountPath: '/work' }, { name: 'tmp', mountPath: '/tmp' }] }],
      containers: [{ name: 'keeper', image, command: ['node', 'keeper/index.mjs'], workingDir: '/work/source/randomness', securityContext,
        env: [{ name: 'NODE_ENV', value: 'production' }, { name: 'PORT', value: '8080' }],
        envFrom: [{ secretRef: { name: 'keeper-runtime' } }], ports: [{ name: 'http', containerPort: 8080 }],
        resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
        startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 5, failureThreshold: 36 },
        readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, timeoutSeconds: 3 },
        livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
        volumeMounts: [{ name: 'code', mountPath: '/work', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }]
      }],
      volumes: [{ name: 'code', emptyDir: { sizeLimit: '1Gi' } }, { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } }]
    } }
  } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'keeper', namespace, labels },
    spec: { selector: labels, ports: [{ name: 'http', port: 80, targetPort: 'http' }] } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'keeper', namespace, labels, annotations: {
    'alb.ingress.kubernetes.io/scheme': 'internet-facing',
    'alb.ingress.kubernetes.io/target-type': 'ip',
    'alb.ingress.kubernetes.io/load-balancer-name': 'mydoge-staging-randomness',
    'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP":80}]',
    'alb.ingress.kubernetes.io/inbound-cidrs': '0.0.0.0/0',
    'alb.ingress.kubernetes.io/healthcheck-path': '/health',
    'alb.ingress.kubernetes.io/success-codes': '200',
    'alb.ingress.kubernetes.io/tags': 'Project=mydoge-wallet-staging,Service=dogeos-randomness-testnet,Environment=testnet'
  } }, spec: { ingressClassName: 'alb', rules: [{ http: { paths: [{ path: '/status', pathType: 'Exact',
    backend: { service: { name: 'keeper', port: { name: 'http' } } } }] } }] } }
];
console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items }, null, 2));
