"use client";

// RBAC sections per the Phase 1 handoff §3.1. The frontend may hide/disable based on
// these, but the backend's 403 response remains authoritative either way.
export interface SocialPermissions {
  social_content: "VIEW" | "EDIT" | null;
  social_content_submit: "EDIT" | null;
  social_approvals: "VIEW" | "EDIT" | null;
  social_publish: "VIEW" | "EDIT" | null;
  social_schedule: "VIEW" | "EDIT" | null;
  social_publish_retry: "EDIT" | null;
  social_publish_cancel: "EDIT" | null;
  social_publish_delete: "EDIT" | null;
  social_inbox: "VIEW" | null;
  social_inbox_reply: "EDIT" | null;
  social_inbox_assign: "EDIT" | null;
  social_inbox_resolve: "EDIT" | null;
  social_inbox_note: "EDIT" | null;
  social_inbox_tag: "EDIT" | null;
  social_moderation_hide: "EDIT" | null;
  social_moderation_delete: "EDIT" | null;
  social_moderation_escalate: "EDIT" | null;
  social_moderation_safety: "EDIT" | null;
  social_moderation_restricted: "VIEW" | null;
  social_connections: "VIEW" | "EDIT" | null;
  social_analytics: "VIEW" | null;
  social_settings: "VIEW" | "EDIT" | null;
  social_operations: "VIEW" | "EDIT" | null;
}

// TODO: replace with the authenticated user's resolved grants once the auth/RBAC
// context is wired into this app. Every screen reads permissions through this hook
// so that swap happens in one place.
export function useSocialPermissions(): SocialPermissions {
  return {
    social_content: "EDIT",
    social_content_submit: "EDIT",
    social_approvals: "EDIT",
    social_publish: "EDIT",
    social_schedule: "EDIT",
    social_publish_retry: "EDIT",
    social_publish_cancel: "EDIT",
    social_publish_delete: "EDIT",
    social_inbox: "VIEW",
    social_inbox_reply: "EDIT",
    social_inbox_assign: "EDIT",
    social_inbox_resolve: "EDIT",
    social_inbox_note: "EDIT",
    social_inbox_tag: "EDIT",
    social_moderation_hide: "EDIT",
    social_moderation_delete: "EDIT",
    social_moderation_escalate: "EDIT",
    social_moderation_safety: "EDIT",
    social_moderation_restricted: "VIEW",
    social_connections: "EDIT",
    social_analytics: "VIEW",
    social_settings: "EDIT",
    social_operations: "EDIT",
  };
}