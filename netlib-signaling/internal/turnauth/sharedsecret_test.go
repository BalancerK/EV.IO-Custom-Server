package turnauth

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" //nolint:gosec // matching the TURN REST API convention under test, not our choice
	"encoding/base64"
	"strconv"
	"testing"
	"time"
)

// Verifies the credential SharedSecretProvider issues is exactly what a
// coturn instance configured with `use-auth-secret` + the same
// static-auth-secret would independently re-derive and accept — the
// convention itself (see sharedsecret.go's doc comment), reproduced here
// from scratch rather than by calling the code under test, so a mistake in
// one can't hide behind the same mistake in the other.
func TestSharedSecretProvider_GetCredentials(t *testing.T) {
	const secret = "test-static-auth-secret"
	const url = "turn:example.com:3478?transport=udp"
	lifetime := time.Hour

	p := NewSharedSecretProvider(url, secret, lifetime)
	before := time.Now()
	creds, err := p.GetCredentials(context.Background())
	after := time.Now()
	if err != nil {
		t.Fatalf("GetCredentials returned an error: %v", err)
	}
	if creds == nil {
		t.Fatal("GetCredentials returned nil credentials with a nil error")
	}

	if creds.URL != url {
		t.Errorf("URL = %q, want %q", creds.URL, url)
	}
	if creds.Lifetime != int(lifetime/time.Second) {
		t.Errorf("Lifetime = %d, want %d", creds.Lifetime, int(lifetime/time.Second))
	}

	// Username must be a plain unix timestamp roughly `lifetime` in the future
	// — coturn's REST API convention derives the credential's expiry directly
	// from parsing this value, so it must be a bare integer, not e.g. a
	// "<timestamp>:<label>" pair (a valid variant of the convention, but NOT
	// what our own coturn side is configured to expect).
	expiry, err := strconv.ParseInt(creds.Username, 10, 64)
	if err != nil {
		t.Fatalf("Username %q is not a plain integer timestamp: %v", creds.Username, err)
	}
	wantExpiryLow := before.Add(lifetime).Unix()
	wantExpiryHigh := after.Add(lifetime).Unix()
	if expiry < wantExpiryLow || expiry > wantExpiryHigh {
		t.Errorf("expiry %d outside expected window [%d, %d]", expiry, wantExpiryLow, wantExpiryHigh)
	}

	// Password must be exactly base64(HMAC-SHA1(secret, username)) — the
	// independently-computed reference coturn itself would compute.
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(creds.Username)) //nolint:errcheck
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if creds.Credential != want {
		t.Errorf("Credential = %q, want %q (HMAC-SHA1 of username %q with the configured secret)",
			creds.Credential, want, creds.Username)
	}

	// A DIFFERENT secret must never validate — the whole point of the scheme.
	wrongMac := hmac.New(sha1.New, []byte("wrong-secret"))
	wrongMac.Write([]byte(creds.Username)) //nolint:errcheck
	wrongPassword := base64.StdEncoding.EncodeToString(wrongMac.Sum(nil))
	if creds.Credential == wrongPassword {
		t.Error("credential matched a HMAC computed with the WRONG secret — should be impossible")
	}
}

func TestSharedSecretProvider_Run_IsANoop(t *testing.T) {
	// Unlike cloudflare.CredentialsClient, there is no background state to
	// refresh — Run must return immediately rather than block, since main.go
	// calls it as `go credentialsClient.Run(ctx)` and never waits on it.
	p := NewSharedSecretProvider("turn:example.com:3478", "secret", time.Hour)
	done := make(chan struct{})
	go func() {
		p.Run(context.Background())
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return promptly — it should be a no-op")
	}
}

func TestNoopProvider(t *testing.T) {
	var p Provider = NoopProvider{}
	creds, err := p.GetCredentials(context.Background())
	if err != nil {
		t.Fatalf("NoopProvider.GetCredentials returned an error: %v", err)
	}
	if creds != nil {
		t.Errorf("NoopProvider.GetCredentials returned non-nil credentials: %+v", creds)
	}
}
