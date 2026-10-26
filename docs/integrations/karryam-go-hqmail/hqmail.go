// Package hqmail is a REFERENCE client showing how a product service (for
// example Karryam Go's notification-service) reports events to CosmicForge
// HQ Mail using contract v1. It is documentation-grade code: the product
// owner decides whether and how to adopt it inside the product repository.
//
// Rules for product teams:
//   - Never call HQ from a request path (booking, login, payment). Write the
//     event to the product's own outbox and deliver it from a worker; HQ
//     being down must never block or fail a product flow.
//   - Reuse one eventId per logical event on every retry (HQ is idempotent
//     on eventId; a different payload with the same id is a 409 conflict).
//     Also set IdempotencyKey (e.g. notifications.IdempotencyKey(...)): HQ
//     dedupes on (integration, idempotencyKey) too, so a retry that was
//     re-enveloped with a fresh eventId is still a duplicate; the same key
//     with a different payload is 409 MAIL_INTEGRATION_IDEMPOTENCY_CONFLICT.
//   - Retry only when Result.Retryable is true (network, 429, 5xx including
//     503 MAIL_SCHEMA_NOT_READY / MAIL_INTEGRATIONS_DISABLED), using
//     Backoff() (exponential, full jitter). Never retry 4xx other than 429.
//   - Never send message content, credentials, or clinical / patient data.
//
// Signing is byte-compatible with Karryam's shared/go/serviceauth, so the
// existing serviceauth.SignRequest can be used instead of sign() below.
package hqmail

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const Path = "/api/mail/v1/integrations/v1/events"

type Envelope struct {
	ContractVersion int    `json:"contractVersion"`
	Product         string `json:"product"`
	Organization    string `json:"organization"`
	EventID         string `json:"eventId"`
	EventType       string `json:"eventType"`
	EventVersion    int    `json:"eventVersion"`
	CorrelationID   string `json:"correlationId,omitempty"`
	IdempotencyKey  string `json:"idempotencyKey,omitempty"`
	// RFC 3339 timestamp; use Timestamp(t) (RFC3339Nano, UTC).
	OccurredAt string      `json:"occurredAt"`
	Data       interface{} `json:"data"`
}

// DeliveryStatus is data for eventType "mail.delivery_status" v1.
type DeliveryStatus struct {
	ProductMessageID  string `json:"productMessageId"`
	Provider          string `json:"provider"`
	ProviderMessageID string `json:"providerMessageId,omitempty"`
	Sender            string `json:"sender"`
	Recipient         string `json:"recipient"`
	Status            string `json:"status"`
	Category          string `json:"category"`
}

// MarketingTrigger is data for eventType "marketing.trigger" v1.
type MarketingTrigger struct {
	TriggerType    string         `json:"triggerType"`
	TriggerVersion int            `json:"triggerVersion"`
	ContactEmail   string         `json:"contactEmail"`
	Attributes     map[string]any `json:"attributes,omitempty"`
}

// Timestamp formats an event time the way HQ expects (RFC3339Nano, UTC),
// identical to how encoding/json marshals a time.Time.
func Timestamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }

// Backoff returns the delay before retry number attempt (1-based):
// exponential from 30s, capped at 30m, with full jitter so a fleet of
// outbox workers does not retry in lockstep after an HQ outage.
func Backoff(attempt int, rnd *rand.Rand) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 7 {
		attempt = 7
	}
	ceiling := time.Duration(1<<uint(attempt-1)) * 30 * time.Second
	if ceiling > 30*time.Minute {
		ceiling = 30 * time.Minute
	}
	if rnd == nil {
		return time.Duration(rand.Int63n(int64(ceiling))) + time.Second
	}
	return time.Duration(rnd.Int63n(int64(ceiling))) + time.Second
}

type Result struct {
	Status    int
	Accepted  bool
	Duplicate bool
	Retryable bool
	Code      string
}

type Client struct {
	BaseURL     string
	ServiceName string
	Secret      []byte
	HTTP        *http.Client
	Now         func() time.Time
}

func sign(method, requestURI, timestamp string, body, secret []byte) string {
	bodyHash := sha256.Sum256(body)
	canonical := strings.Join([]string{strings.ToUpper(method), requestURI, timestamp, hex.EncodeToString(bodyHash[:])}, "\n")
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(canonical))
	return hex.EncodeToString(mac.Sum(nil))
}

func (c *Client) Send(ctx context.Context, env Envelope) (Result, error) {
	if env.ContractVersion == 0 {
		env.ContractVersion = 1
	}
	body, err := json.Marshal(env)
	if err != nil {
		return Result{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+Path, bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	now := time.Now
	if c.Now != nil {
		now = c.Now
	}
	ts := strconv.FormatInt(now().Unix(), 10)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Service-Name", c.ServiceName)
	req.Header.Set("X-Service-Timestamp", ts)
	req.Header.Set("X-Service-Signature", sign(http.MethodPost, req.URL.RequestURI(), ts, body, c.Secret))
	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		// Network errors are retryable; the eventId makes the retry safe.
		return Result{Retryable: true, Code: "NETWORK_ERROR"}, err
	}
	defer resp.Body.Close()
	var payload struct {
		Success   bool   `json:"success"`
		Code      string `json:"code"`
		Retryable bool   `json:"retryable"`
		Data      struct {
			Accepted  bool `json:"accepted"`
			Duplicate bool `json:"duplicate"`
		} `json:"data"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&payload)
	result := Result{Status: resp.StatusCode, Accepted: payload.Data.Accepted, Duplicate: payload.Data.Duplicate, Retryable: payload.Retryable || resp.StatusCode == 429 || resp.StatusCode >= 500, Code: payload.Code}
	if resp.StatusCode >= 300 {
		return result, fmt.Errorf("hq mail rejected event: %d %s", resp.StatusCode, payload.Code)
	}
	return result, nil
}
