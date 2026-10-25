package hqmail

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Same vector as services/central-admin-api/tests/mail-m8-unit.test.js and
// Karryam Go's shared/go/serviceauth.SignRequest.
func TestSignatureVector(t *testing.T) {
	got := sign("POST", "/api/mail/v1/integrations/v1/events", "1761350400", []byte(`{"contractVersion":1}`), []byte("vector-secret-0123456789"))
	if got != "f2d6ea185346e6460abaf673214319f2b29e6a00f0c1e4593aaa3168c68e7f27" {
		t.Fatalf("signature vector mismatch: %s", got)
	}
}

func TestSendSignsAndClassifies(t *testing.T) {
	secret := []byte("reference-secret-0123456789abcdef")
	var seen Envelope
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Service-Signature") != sign(r.Method, r.URL.RequestURI(), r.Header.Get("X-Service-Timestamp"), body, secret) {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"success":false,"code":"MAIL_INTEGRATION_UNAUTHORIZED","retryable":false}`))
			return
		}
		_ = json.Unmarshal(body, &seen)
		if seen.EventID == "retry-me" {
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"success":false,"code":"MAIL_STORAGE_UNAVAILABLE","retryable":true}`))
			return
		}
		w.WriteHeader(202)
		_, _ = w.Write([]byte(`{"success":true,"data":{"accepted":true,"duplicate":false}}`))
	}))
	defer server.Close()
	client := &Client{BaseURL: server.URL, ServiceName: "karryam-notification-service", Secret: secret, Now: func() time.Time { return time.Unix(1761350400, 0) }}
	event := Envelope{Product: "karryam", Organization: "karryam", EventID: "evt-1", EventType: "mail.delivery_status", EventVersion: 1, OccurredAt: "2026-10-25T00:00:00Z",
		Data: DeliveryStatus{ProductMessageID: "m-1", Provider: "resend", Sender: "noreply@karryam.example", Recipient: "rider@example.com", Status: "DELIVERED", Category: "booking_confirmation"}}
	result, err := client.Send(context.Background(), event)
	if err != nil || !result.Accepted || seen.ContractVersion != 1 {
		t.Fatalf("expected acceptance, got %+v %v", result, err)
	}
	event.EventID = "retry-me"
	result, err = client.Send(context.Background(), event)
	if err == nil || !result.Retryable {
		t.Fatalf("503 must be retryable, got %+v", result)
	}
	bad := &Client{BaseURL: server.URL, ServiceName: "karryam-notification-service", Secret: []byte("wrong"), Now: client.Now}
	result, err = bad.Send(context.Background(), event)
	if err == nil || result.Retryable || result.Status != 401 {
		t.Fatalf("401 must not be retryable, got %+v", result)
	}
}
