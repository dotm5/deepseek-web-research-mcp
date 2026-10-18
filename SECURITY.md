# Security

API keys are accepted only through hidden terminal input or stdin. They are validated
before OS-vault storage and are never written into MCP registrations. This protects
against accidental config/history exposure, not arbitrary code running as the same user.
The headless AES-GCM fallback is weaker than an OS credential service.

Fetched pages are untrusted content. Local discovery restricts destinations to public
IPs and validates redirects, Host/SNI and TLS. Tool request, time and content limits
are enforced, and partial failures remain visible.

Do not report a vulnerability by posting keys or raw local logs in a public issue.
Once the GitHub repository is created, enable GitHub private vulnerability reporting
and use its Security tab for sensitive reports. Rotate a disclosed credential at its
provider before sharing a minimal, redacted reproduction.

Maintainers should run the package/source scanner and review the npm tarball before
each release. The scanner is a release gate, not a guarantee that all possible secret
formats can be detected.
