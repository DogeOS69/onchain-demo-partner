import assert from 'node:assert/strict';

const { SOURCE_COMMIT, WEB_ORIGIN, CLOUDFRONT_PREFIX_LIST } = process.env;
assert(/^[a-f0-9]{40}$/.test(SOURCE_COMMIT ?? ''), 'Set a full SOURCE_COMMIT');
assert(WEB_ORIGIN?.startsWith('https://'), 'Set WEB_ORIGIN');
assert(/^pl-[a-f0-9]+$/.test(CLOUDFRONT_PREFIX_LIST ?? ''), 'Set CLOUDFRONT_PREFIX_LIST');
const namespace = 'dogeos-aa-testnet';
const labels = { 'app.kubernetes.io/name': 'dogeos-aa-testnet' };
const nodeImage = 'node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54';
const securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
const bootstrap = `
  const fs = require('node:fs');
  const {execFileSync} = require('node:child_process');
  (async () => {
    const url = 'https://codeload.github.com/DogeOS69/onchain-demo-partner/tar.gz/' + process.env.SOURCE_COMMIT;
    const response = await fetch(url, {signal: AbortSignal.timeout(120000)});
    if (!response.ok) throw new Error('Source download: HTTP ' + response.status);
    fs.writeFileSync('/work/source.tar.gz', Buffer.from(await response.arrayBuffer()));
    fs.mkdirSync('/work/source', {recursive:true});
    execFileSync('tar', ['-xzf','/work/source.tar.gz','--strip-components=1','-C','/work/source']);
    execFileSync('npm', ['ci','--omit=dev','--no-audit','--no-fund','--cache','/tmp/npm'], {cwd:'/work/source/aa',stdio:'inherit'});
    fs.rmSync('/work/source.tar.gz');
  })().catch(error => {console.error(error.message);process.exit(1)});
`;
const objects = [
  { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace, labels: { ...labels,
    'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/enforce-version': 'latest' } } },
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'aa-state', namespace, labels },
    spec: { accessModes: ['ReadWriteOnce'], storageClassName: 'gp3', resources: { requests: { storage: '1Gi' } } } },
  { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'aa', namespace, labels }, spec: {
    replicas: 1, strategy: { type: 'Recreate' }, revisionHistoryLimit: 3,
    selector: { matchLabels: labels }, template: { metadata: { labels, annotations: { 'dogeos.com/source-commit': SOURCE_COMMIT } }, spec: {
      automountServiceAccountToken: false, terminationGracePeriodSeconds: 30,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      initContainers: [{ name: 'prepare-code', image: nodeImage, command: ['node', '-e', bootstrap], securityContext,
        env: [{ name: 'SOURCE_COMMIT', value: SOURCE_COMMIT }],
        resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '2Gi' } },
        volumeMounts: [{ name: 'code', mountPath: '/work' }, { name: 'tmp', mountPath: '/tmp' }] }],
      containers: [{ name: 'aa', image: nodeImage, command: ['node', 'server.mjs'], workingDir: '/work/source/aa', securityContext,
        env: [ { name: 'NODE_ENV', value: 'production' }, { name: 'AA_BIND_HOST', value: '0.0.0.0' },
          { name: 'PORT', value: '4341' }, { name: 'AA_STATE_DIR', value: '/data' }, { name: 'WEB_ORIGIN', value: WEB_ORIGIN } ],
        envFrom: [{ secretRef: { name: 'aa-runtime' } }], ports: [{ name: 'http', containerPort: 4341 }],
        resources: { requests: { cpu: '250m', memory: '512Mi' }, limits: { cpu: '1', memory: '1536Mi' } },
        startupProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 5, failureThreshold: 36 },
        readinessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 10, timeoutSeconds: 3 },
        livenessProbe: { httpGet: { path: '/health', port: 'http' }, periodSeconds: 20, timeoutSeconds: 3, failureThreshold: 6 },
        volumeMounts: [{ name: 'code', mountPath: '/work', readOnly: true }, { name: 'state', mountPath: '/data' }, { name: 'tmp', mountPath: '/tmp' }]
      }],
      volumes: [{ name: 'code', emptyDir: { sizeLimit: '2Gi' } }, { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'state', persistentVolumeClaim: { claimName: 'aa-state' } }]
    } }
  } },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: 'aa', namespace, labels },
    spec: { selector: labels, ports: [{ name: 'http', port: 80, targetPort: 'http' }] } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'aa', namespace, labels, annotations: {
    'alb.ingress.kubernetes.io/scheme': 'internet-facing',
    'alb.ingress.kubernetes.io/target-type': 'ip',
    'alb.ingress.kubernetes.io/load-balancer-name': 'mydoge-wallet-staging-aa',
    'alb.ingress.kubernetes.io/listen-ports': '[{"HTTP":80}]',
    'alb.ingress.kubernetes.io/security-group-prefix-lists': CLOUDFRONT_PREFIX_LIST,
    'alb.ingress.kubernetes.io/healthcheck-path': '/health',
    'alb.ingress.kubernetes.io/success-codes': '200',
    'alb.ingress.kubernetes.io/tags': 'Project=mydoge-wallet-staging,Service=dogeos-aa-testnet,Environment=testnet',
    'alb.ingress.kubernetes.io/load-balancer-attributes': 'idle_timeout.timeout_seconds=90'
  } }, spec: { ingressClassName: 'alb', rules: [{ http: { paths: [{ path: '/', pathType: 'Prefix',
    backend: { service: { name: 'aa', port: { name: 'http' } } } }] } }] } }
];
console.log(JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects }, null, 2));
