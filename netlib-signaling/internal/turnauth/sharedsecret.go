package turnauth

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // required by the TURN REST API convention itself, not our choice
	"encoding/base64"
	"fmt"
	"time"
)

// SharedSecretProvider computes coturn-compatible ephemeral credentials
// locally, following the "TURN REST API" convention coturn implements when
// configured with `use-auth-secret` + `static-auth-secret=<secret>` in
// turnserver.conf (the same convention Twilio/Xirsys use, and what coturn's
// own docs call the REST API method — see coturn/docs/turn_rest.pdf):
//
//	username = <unix expiry timestamp>
//	password = base64(HMAC-SHA1(secret, username))
//
// coturn re-derives the same HMAC from its own copy of the secret and the
// username the client presents, so nothing is fetched over the network and
// nothing is cached — unlike Cloudflare's API-fetched credentials (see
// cloudflare.CredentialsClient), a fresh, valid credential can be computed
// synchronously on every call. Run is therefore a no-op: there is no
// background state to refresh.
type SharedSecretProvider struct {
	url      string
	secret   string
	lifetime time.Duration
}

// NewSharedSecretProvider builds a provider for a self-hosted coturn.
//   - url: the turn: URI clients should dial, e.g. "turn:your-vps:3478?transport=udp"
//   - secret: must exactly match turnserver.conf's static-auth-secret
//   - lifetime: how long each issued credential remains valid for
func NewSharedSecretProvider(url, secret string, lifetime time.Duration) *SharedSecretProvider {
	return &SharedSecretProvider{url: url, secret: secret, lifetime: lifetime}
}

func (p *SharedSecretProvider) Run(ctx context.Context) {}

func (p *SharedSecretProvider) GetCredentials(ctx context.Context) (*Credentials, error) {
	expiry := time.Now().Add(p.lifetime).Unix()
	username := fmt.Sprintf("%d", expiry)

	mac := hmac.New(sha1.New, []byte(p.secret))
	mac.Write([]byte(username)) //nolint:errcheck // hash.Hash.Write never returns an error
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	return &Credentials{
		URL:        p.url,
		Username:   username,
		Credential: password,
		Lifetime:   int(p.lifetime / time.Second),
	}, nil
}
