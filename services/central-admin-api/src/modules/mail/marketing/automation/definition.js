"use strict";

// Versioned automation definitions: a bounded, acyclic graph of steps.
//   { topic, entryStepId, steps: [
//       { id, type: "send_email", templateVersionId, senderAddressId, subjectOverride?, next },
//       { id, type: "delay", minutes, next },
//       { id, type: "condition", condition: { field, op, value }, then, else },
//       { id, type: "exit" } ] }
// Trigger configs:
//   CONSENT_GRANTED { topic }                     (must equal definition.topic)
//   PRODUCT_EVENT   { eventType, version }        (approved registry only)
//   SCHEDULE        { frequency, localTime, timeZone, weekday?, dayOfMonth?, audienceId, segmentId? }

const crypto = require("crypto");
const { approvedEvent } = require("./event-registry");
const { isValidTimeZone } = require("../scheduling");

const STEP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TOPIC = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPS = new Set(["equals", "not_equals", "contains", "in", "exists", "gt", "lt"]);
const FIELD = /^(first_name|last_name|email_domain|attributes\.[a-zA-Z][a-zA-Z0-9_]{0,40}|event\.[a-zA-Z][a-zA-Z0-9_]{0,40}|engagement\.(previous_send_delivered|previous_send_opened|previous_send_clicked))$/;
const MAX_STEPS = 30;
const MAX_SEND_STEPS = 10;
const MAX_DELAY_MINUTES = 90 * 24 * 60;

class DefinitionError extends Error {
  constructor(errors) {
    super("Invalid automation definition");
    this.errors = errors;
  }
}

function validateDefinition(input) {
  const errors = [];
  const definition = input && typeof input === "object" ? input : {};
  const topic = String(definition.topic || "").trim().toLowerCase();
  if (!TOPIC.test(topic)) errors.push({ field: "definition.topic" });
  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (!steps.length || steps.length > MAX_STEPS) errors.push({ field: "definition.steps", reason: `1-${MAX_STEPS}_STEPS` });
  const ids = new Set();
  const clean = [];
  steps.slice(0, MAX_STEPS).forEach((step, index) => {
    const at = `definition.steps[${index}]`;
    const id = String(step?.id || "");
    if (!STEP_ID.test(id) || ids.has(id)) errors.push({ field: `${at}.id`, reason: ids.has(id) ? "DUPLICATE" : "INVALID" });
    ids.add(id);
    const ref = (value) => (value == null || value === "" ? null : String(value));
    switch (step?.type) {
      case "send_email":
        if (!UUID.test(String(step.templateVersionId || ""))) errors.push({ field: `${at}.templateVersionId` });
        if (!UUID.test(String(step.senderAddressId || ""))) errors.push({ field: `${at}.senderAddressId` });
        clean.push({ id, type: "send_email", templateVersionId: String(step.templateVersionId), senderAddressId: String(step.senderAddressId), subjectOverride: step.subjectOverride ? String(step.subjectOverride).replace(/[\r\n]+/g, " ").slice(0, 998) : null, next: ref(step.next) });
        break;
      case "delay": {
        const minutes = Number(step.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_DELAY_MINUTES) errors.push({ field: `${at}.minutes`, reason: `1-${MAX_DELAY_MINUTES}` });
        clean.push({ id, type: "delay", minutes, next: ref(step.next) });
        break;
      }
      case "condition": {
        const condition = step.condition || {};
        if (!FIELD.test(String(condition.field || ""))) errors.push({ field: `${at}.condition.field` });
        if (!OPS.has(condition.op)) errors.push({ field: `${at}.condition.op` });
        const value = condition.op === "in" ? (Array.isArray(condition.value) ? condition.value.slice(0, 50).map((entry) => String(entry).slice(0, 120)) : null) : condition.value == null ? null : String(condition.value).slice(0, 120);
        if (condition.op !== "exists" && (value == null || (Array.isArray(value) && !value.length))) errors.push({ field: `${at}.condition.value` });
        clean.push({ id, type: "condition", condition: { field: String(condition.field), op: condition.op, value }, then: ref(step.then), else: ref(step.else) });
        break;
      }
      case "exit":
        clean.push({ id, type: "exit" });
        break;
      default:
        errors.push({ field: `${at}.type`, reason: "UNSUPPORTED" });
    }
  });
  const byId = new Map(clean.map((step) => [step.id, step]));
  const entryStepId = String(definition.entryStepId || clean[0]?.id || "");
  if (!byId.has(entryStepId)) errors.push({ field: "definition.entryStepId" });
  for (const step of clean) {
    for (const key of ["next", "then", "else"]) {
      if (step[key] != null && !byId.has(step[key])) errors.push({ field: `step ${step.id}.${key}`, reason: "UNKNOWN_STEP" });
    }
  }
  if (clean.filter((step) => step.type === "send_email").length > MAX_SEND_STEPS) errors.push({ field: "definition.steps", reason: `MAX_${MAX_SEND_STEPS}_SEND_STEPS` });
  if (!clean.some((step) => step.type === "send_email")) errors.push({ field: "definition.steps", reason: "SEND_STEP_REQUIRED" });
  // Acyclic: every path must terminate.
  const state = new Map();
  const visit = (id, depth = 0) => {
    if (id == null || !byId.has(id) || depth > MAX_STEPS) return;
    if (state.get(id) === "visiting") {
      errors.push({ field: "definition.steps", reason: "CYCLE", at: id });
      return;
    }
    if (state.get(id) === "done") return;
    state.set(id, "visiting");
    const step = byId.get(id);
    for (const key of ["next", "then", "else"]) visit(step[key], depth + 1);
    state.set(id, "done");
  };
  visit(entryStepId);
  const unreachable = clean.filter((step) => !state.has(step.id)).map((step) => step.id);
  if (unreachable.length) errors.push({ field: "definition.steps", reason: "UNREACHABLE", steps: unreachable });
  if (errors.length) throw new DefinitionError(errors);
  return { topic, entryStepId, steps: clean };
}

function validateTriggerConfig(triggerType, input, definition) {
  const config = input && typeof input === "object" ? input : {};
  const errors = [];
  let clean;
  if (triggerType === "CONSENT_GRANTED") {
    const topic = String(config.topic || definition.topic || "").toLowerCase();
    if (topic !== definition.topic) errors.push({ field: "triggerConfig.topic", reason: "MUST_EQUAL_DEFINITION_TOPIC" });
    clean = { topic };
  } else if (triggerType === "PRODUCT_EVENT") {
    const eventType = String(config.eventType || "");
    const version = Number(config.version || 1);
    if (!approvedEvent(eventType, version)) errors.push({ field: "triggerConfig.eventType", reason: "NOT_AN_APPROVED_PRODUCT_EVENT" });
    clean = { eventType, version };
  } else if (triggerType === "SCHEDULE") {
    const frequency = String(config.frequency || "");
    if (!["daily", "weekly", "monthly"].includes(frequency)) errors.push({ field: "triggerConfig.frequency" });
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(config.localTime || ""))) errors.push({ field: "triggerConfig.localTime" });
    if (!isValidTimeZone(config.timeZone)) errors.push({ field: "triggerConfig.timeZone" });
    if (frequency === "weekly" && !(Number.isInteger(Number(config.weekday)) && Number(config.weekday) >= 0 && Number(config.weekday) <= 6)) errors.push({ field: "triggerConfig.weekday" });
    if (frequency === "monthly" && !(Number.isInteger(Number(config.dayOfMonth)) && Number(config.dayOfMonth) >= 1 && Number(config.dayOfMonth) <= 28)) errors.push({ field: "triggerConfig.dayOfMonth" });
    if (!UUID.test(String(config.audienceId || ""))) errors.push({ field: "triggerConfig.audienceId" });
    if (config.segmentId && !UUID.test(String(config.segmentId))) errors.push({ field: "triggerConfig.segmentId" });
    clean = { frequency, localTime: String(config.localTime || ""), timeZone: String(config.timeZone || ""), ...(frequency === "weekly" ? { weekday: Number(config.weekday) } : {}), ...(frequency === "monthly" ? { dayOfMonth: Number(config.dayOfMonth) } : {}), audienceId: String(config.audienceId || ""), segmentId: config.segmentId ? String(config.segmentId) : null };
  } else {
    errors.push({ field: "triggerType" });
  }
  if (errors.length) throw new DefinitionError(errors);
  return clean;
}

function definitionHash(definition, triggerConfig) {
  return crypto.createHash("sha256").update(JSON.stringify({ definition, triggerConfig })).digest("hex");
}

function evaluateCondition(condition, { contact, eventPayload = {}, engagement = {} }) {
  const field = condition.field;
  let raw;
  if (field === "first_name") raw = contact.firstName;
  else if (field === "last_name") raw = contact.lastName;
  else if (field === "email_domain") raw = String(contact.email).split("@")[1];
  else if (field.startsWith("attributes.")) raw = (contact.attributes || {})[field.slice(11)];
  else if (field.startsWith("event.")) raw = eventPayload[field.slice(6)];
  else if (field.startsWith("engagement.")) raw = engagement[field.slice(11)] ? "true" : "false";
  const value = raw == null ? null : String(raw);
  const target = condition.value;
  switch (condition.op) {
    case "exists": return value != null && value !== "";
    case "equals": return value != null && value.toLowerCase() === String(target).toLowerCase();
    case "not_equals": return value == null || value.toLowerCase() !== String(target).toLowerCase();
    case "contains": return value != null && value.toLowerCase().includes(String(target).toLowerCase());
    case "in": return value != null && target.map((entry) => entry.toLowerCase()).includes(value.toLowerCase());
    case "gt": return value != null && Number(value) > Number(target);
    case "lt": return value != null && Number(value) < Number(target);
    default: return false;
  }
}

module.exports = { validateDefinition, validateTriggerConfig, definitionHash, evaluateCondition, DefinitionError, MAX_STEPS, MAX_DELAY_MINUTES };
