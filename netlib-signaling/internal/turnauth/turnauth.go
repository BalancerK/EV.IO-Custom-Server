// Package turnauth defines the provider interface every TURN credential source
// (Cloudflare Calls, a self-hosted coturn via the shared-secret/"TURN REST API"
// convention, or none at all) implements, so internal/signaling never has to
// know which one is in use.
//
// WHY THIS EXISTS: the vendored upstream wired internal/signaling directly to
// the concrete *cloudflare.CredentialsClient type, so TURN was Cloudflare-only
// by construction. We vendored this repo specifically so we could self-host
// TURN via our own coturn instead of taking on a Cloudflare Calls account as a
// second third-party dependency — this interface is the seam that makes both
// implementations (see cloudflare.CredentialsClient and SharedSecretProvider)
// drop-in interchangeable from main.go, with zero changes to signaling itself.
package turnauth

import "context"

// Credentials mirrors cloudflare.Credentials field-for-field (that package
// keeps a type alias to this one — see its credentials.go) so existing
// callers and JSON field names are untouched.
type Credentials struct {
	URL        string `json:"url"`
	Username   string `json:"username"`
	Credential string `json:"credential"`
	Lifetime   int    `json:"lifetime"`
}

// Provider is anything that can hand out TURN credentials on demand. Run is
// for providers that need a background refresh loop (Cloudflare's API-fetched
// credentials do; a locally-computed HMAC does not, so SharedSecretProvider's
// Run is a no-op) — called once, same as before, from main.go's `go`.
type Provider interface {
	Run(ctx context.Context)
	GetCredentials(ctx context.Context) (*Credentials, error)
}

// NoopProvider hands out no TURN server at all — STUN-only. Used when neither
// TURN_SHARED_SECRET nor CLOUDFLARE_APP_ID is configured, so a deployment that
// genuinely wants no TURN (e.g. local dev, or players never behind a strict
// NAT) doesn't need a dummy config value to satisfy the interface.
type NoopProvider struct{}

func (NoopProvider) Run(context.Context) {}
func (NoopProvider) GetCredentials(context.Context) (*Credentials, error) {
	return nil, nil
}
