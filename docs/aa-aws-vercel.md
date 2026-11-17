# AA testnet deployment on AWS and Vercel

This deployment serves the existing Chikyu EntryPoint v0.9, SimpleAccount
factory and salt-0 counter flow. Accounts pay their own DOGE. EIP-7702 and
paymasters remain disabled.

The Vercel Next.js server forwards the restricted AA API to an AWS CloudFront
HTTPS endpoint. CloudFront disables caching and forwards the server-only
`x-aa-api-token` header to a dedicated Application Load Balancer. The ALB
accepts HTTP only from the AWS-managed CloudFront origin prefix list; this
origin hop is HTTP, not end-to-end TLS. The application requires the shared
token for all API requests except its health check. Raw Alto RPC stays on
loopback. Neither executor keys nor the API token enter the browser bundle.

The existing staging EKS cluster runs a single replica in its own
`dogeos-aa-testnet` namespace with a 1 GiB persistent gp3 volume. Updates use
`Recreate` to avoid simultaneous writers/executors. The AWS installation has
its own funded testnet executor, so it can be verified independently of the
existing Railway installation.

No private image repository is required for this demo: an official Node 24
image is pinned by digest, and an init container downloads a full pinned
GitHub commit from this public repository and runs `npm ci` against its lock
file. New pod startup therefore requires access to GitHub and npm. A built,
immutable application image can replace this bootstrap when dedicated
registry permissions are available.

Create the namespace, then provision a Kubernetes secret named `aa-runtime`
containing `BUNDLER_EXECUTOR_PRIVATE_KEY`, its matching
`BUNDLER_EXECUTOR_ADDRESS`, and a random `AA_API_TOKEN` of at least 32
characters. Never commit these values. Render the manifests with:

```bash
SOURCE_COMMIT=<full-commit> \
WEB_ORIGIN=https://dogeos-aa-testnet.vercel.app \
CLOUDFRONT_PREFIX_LIST=<regional-cloudfront-prefix-list> \
node deploy/aws/render.mjs > /tmp/aa-testnet.json
kubectl --context mydoge-wallet-staging apply -f /tmp/aa-testnet.json
```

Create the CloudFront distribution against this deployment's ALB, allowing
GET/HEAD/OPTIONS/POST, with caching disabled, viewer HTTPS required and the
`x-aa-api-token` header forwarded. Vercel needs the resulting `AA_API_URL`,
the same `AA_API_TOKEN`, `WEB_ORIGIN` and the registered SDK public settings.
Register the final Vercel origin with the SDK client before enabling social
login. This is a testnet counter demo, not a general public bundler.

## Deployment status

Frontend: https://dogeos-aa-testnet.vercel.app/aa

The AWS service and Vercel deployment are live. Ten backend tests and the web
build pass. A real Chikyu operation, sent through the published Vercel API to
AWS, incremented the counter with user-paid gas and a zero paymaster. The
confirmed receipt survived replacement of the AWS pod. See
[deployment validation](aa-aws-vercel-validation.json) for the transaction and
exact verification scope.

Google/X login on the new origin is pending SDK client registration:
`https://dogeos-aa-testnet.vercel.app` must be added to the same project that
already permits `https://partner-demos-lab.up.railway.app`. Browser checks
confirmed that the existing origin starts the authentication flow while the
new origin is rejected by the relay's CORS policy. The previous Railway
installation is still available.
