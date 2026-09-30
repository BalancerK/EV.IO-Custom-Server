package cloudflare

import (
	"strings"

	"github.com/poki/netlib/internal/turnauth"
)

// Credentials is a type ALIAS (not a new type) to turnauth.Credentials, so
// this package's existing exported API (field names, JSON tags, every
// existing caller of cloudflare.Credentials) is completely unchanged, while
// *CredentialsClient below now also satisfies turnauth.Provider — see that
// package's doc comment for why this seam exists.
type Credentials = turnauth.Credentials

type response struct {
	ICEServers struct {
		URLs       []string `json:"urls"`
		Userid     string   `json:"username"`
		Credential string   `json:"credential"`
	} `json:"iceServers"`
}

// URL returns in the following format:
// turn:webrtc-turn.example.com:50000?transport=udp
func (r response) URL() string {
	for _, url := range r.ICEServers.URLs {
		if strings.HasPrefix(url, "turn:") && strings.Contains(url, "?transport=udp") {
			return url
		}
	}

	return ""
}
