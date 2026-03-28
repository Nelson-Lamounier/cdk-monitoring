# Cognito Auth Architecture Review

This document breaks down the infrastructure-level flow of your new AWS Cognito + Next.js authentication implementation.

## 1. End-to-End Traffic Flow

Your setup involves a modern decouple between the Edge (CloudFront), the Ingress (Traefik), and the Application (Next.js pods) inside your self-hosted Kubernetes cluster.

### The Authentication Loop
1. **Initial Request**: User visits `https://nelsonlamounier.com/admin/login`.
   - **CloudFront** serves the static HTML/JS chunks from the edge cache or your Next.js cluster.
2. **SSO Redirect**: User clicks "Sign In with AWS". Next.js (client-side) redirects the browser to `https://portfolio-admin.auth.eu-west-1.amazoncognito.com/login...` (The Cognito Hosted UI).
3. **Cognito Handling**: AWS manages the login form, MFA, rate-limiting, and credentials validation entirely on their infrastructure. Your cluster sees zero login traffic.
4. **OAuth Callback**: Cognito redirects the user's browser back to `https://nelsonlamounier.com/api/auth/callback/cognito?code=xyz...`
5. **Session Resolution**: 
   - **CloudFront** passes the request to your K8s node ingress (Traefik).
   - **Traefik** routes it to your Next.js pod.
   - **Next.js Pod** makes a direct, server-to-server outbound HTTPS call to the Cognito OIDC Issuer URL (`https://cognito-idp.eu-west-1.amazonaws.com/...`) to exchange the `code` for a JWT.
   - Next.js issues a `Set-Cookie` header to the browser storing a secure, HTTPOnly session token.

---

## 2. CloudFront Considerations

Since CloudFront sits between the user and your K8s Next.js pods, its caching behaviours heavily impact the auth flow.

### Caching Behaviours & Path Patterns
You MUST ensure CloudFront is configured to bypass the cache and forward ALL headers/cookies for specific paths:

- **`/api/auth/*`**: Must forward everything (cookies, query strings, headers) to the origin. This handles the OIDC OAuth callback and session validation.
- **`/admin/*`**: Must forward cookies and `Authorization` headers to the origin so Next.js middleware can validate the session cookie on every request to protected routes.

### Expected Cookies
NextAuth (Auth.js) relies entirely on cookies. CloudFront must forward these specific cookies to the Next.js origin:
- `__Secure-authjs.session-token` (The actual JWT session)
- `__Host-authjs.csrf-token` (Used during the OAuth handshake to prevent CSRF)
- `authjs.callback-url` (Used to know where to redirect after a successful login)

---

## 3. Kubernetes Ingress (Traefik)

Next.js (NextAuth specifically) requires absolute URLs for callbacks and redirects. When running behind a reverse proxy (Traefik) and an Edge CDN (CloudFront), NextAuth needs to know the original requesting Host and Protocol.

### Trusted Host Setup
- **`trustHost: true`**: In `src/lib/auth.ts`, we explicitly set this. It tells NextAuth to trust proxy headers.
- **X-Forwarded Headers**: Traefik must ensure `X-Forwarded-Host` (`nelsonlamounier.com`) and `X-Forwarded-Proto` (`https`) are correctly passed down to the Next.js pod. If these are stripped by CloudFront or Traefik, NextAuth will generate HTTP `localhost` callback URLs and the OAuth flow will fail with `redirect_mismatch`.

---

## 4. Kubernetes Pod & Node Permissions

A massive benefit of swapping from the AWS SDK (e.g., calling `CognitoIdentityProviderClient.initiateAuth`) to an **OIDC OAuth flow** is the reduction in IAM privileges required by your K8s cluster.

### Pod Roles / Service Accounts (IRSA)
- **Zero AWS IAM Permissions Needed**: The Next.js pod DOES NOT need `cognito-idp:*` permissions. 
- Why? NextAuth uses the standard OAuth 2.0 protocol (`oauth4webapi` client library) to make raw HTTPS requests to the public Cognito OIDC endpoints. It authenticates those requests using the `Client ID` (and PKCE, since we disabled the client secret for a public client). It does not use signed AWS API requests (SigV4).

### Host Node Permissions
- Your underlying EC2/Bare-metal nodes do not require any specific AWS IAM instance profiles for Cognito to work.

---

## 5. Security Posture Summary

- **No Secrets in Memory**: Since we used `generateSecret: false` and PKCE in `auth.ts`, there is no highly privileged Client Secret sitting in your K8s cluster that could be leaked if the pod is compromised.
- **DDoS Protection**: Brute force login attempts hit AWS Cognito infrastructure directly, completely shielding your self-hosted K8s cluster from authentication-related CPU spikes.
- **Stateless Tokens**: The Next.js session is a tiny encrypted JWT stored in a browser cookie. Your K8s pods remain completely stateless, meaning they can autoscale, crash, and reboot without logging you out.
