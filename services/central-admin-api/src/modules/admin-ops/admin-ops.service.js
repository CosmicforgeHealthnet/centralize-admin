const { mainPrisma } = require("../../shared/config/mainDatabase");
const ApiError = require("../../shared/utils/ApiError");
const logger = require("../../shared/utils/logger");

class AdminOpsService {
  // ─── Service Registry ───────────────────────────────────────────────

  async listServices({ status, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (status) where.status = status;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_service_registry.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_service_registry.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listServices error:", err.message);
      throw err;
    }
  }

  async getService(id) {
    const service = await mainPrisma.admin_ops_service_registry.findUnique({
      where: { id },
    });
    if (!service) throw new ApiError(404, "Service not found");
    return service;
  }

  async registerService(data) {
    try {
      return await mainPrisma.admin_ops_service_registry.create({ data });
    } catch (err) {
      if (err.code === "P2002")
        throw new ApiError(409, "Service name already exists");
      throw err;
    }
  }

  async updateService(id, data) {
    await this.getService(id);
    return mainPrisma.admin_ops_service_registry.update({
      where: { id },
      data,
    });
  }

  async deregisterService(id) {
    await this.getService(id);
    await mainPrisma.admin_ops_service_registry.delete({ where: { id } });
  }

  async pingService(id) {
    const service = await this.getService(id);
    if (!service.healthEndpoint)
      throw new ApiError(400, "Service has no health endpoint configured");

    let status = "down";
    let responseTimeMs = null;
    let errorMessage = null;

    try {
      const start = Date.now();
      const res = await fetch(service.healthEndpoint, {
        signal: AbortSignal.timeout(5000),
      });
      responseTimeMs = Date.now() - start;
      status = res.ok ? "up" : "degraded";

      if (!res.ok) {
        errorMessage = `HTTP ${res.status}: ${res.statusText}`;
      }
    } catch (error) {
      status = "down";
      errorMessage = error.message;
    }

    // Update service registry
    const updated = await mainPrisma.admin_ops_service_registry.update({
      where: { id },
      data: { status, lastCheckedAt: new Date() },
    });

    // Save to health history
    await mainPrisma.admin_ops_health_check_history.create({
      data: {
        status: status,
        version: service.version || "1.0.0",
        environment: service.environment || "production",
        responseTimeMs: responseTimeMs,
        uptime: null, // Would need to be returned from service health endpoint
        details: {
          serviceId: id,
          serviceName: service.name,
          healthEndpoint: service.healthEndpoint,
          error: errorMessage,
        },
        checkedAt: new Date(),
      },
    });

    // Auto-create alert if service is down
    if (status === "down") {
      const existingAlert = await mainPrisma.admin_ops_system_alerts.findFirst({
        where: {
          type: "health_degraded",
          source: service.name,
          isResolved: false,
        },
        orderBy: { createdAt: "desc" },
      });

      if (!existingAlert) {
        await mainPrisma.admin_ops_system_alerts.create({
          data: {
            type: "health_degraded",
            severity: "critical",
            message: `${service.displayName} service is DOWN`,
            source: service.name,
            details: {
              serviceId: id,
              status,
              responseTimeMs,
              error: errorMessage,
            },
            isRead: false,
            isResolved: false,
          },
        });
        logger.warn(
          `[Alerts] Auto-created critical alert for ${service.displayName} (DOWN)`,
        );
      }
    } else if (status === "degraded") {
      const existingAlert = await mainPrisma.admin_ops_system_alerts.findFirst({
        where: {
          type: "health_degraded",
          source: service.name,
          severity: "warning",
          isResolved: false,
        },
      });

      if (!existingAlert) {
        await mainPrisma.admin_ops_system_alerts.create({
          data: {
            type: "health_degraded",
            severity: "warning",
            message: `${service.displayName} service is DEGRADED (slow or error response)`,
            source: service.name,
            details: {
              serviceId: id,
              status,
              responseTimeMs,
              error: errorMessage,
            },
            isRead: false,
            isResolved: false,
          },
        });
        logger.warn(
          `[Alerts] Auto-created warning alert for ${service.displayName} (DEGRADED)`,
        );
      }
    } else if (status === "up") {
      // Auto-resolve any existing alerts when service is back up
      await mainPrisma.admin_ops_system_alerts.updateMany({
        where: {
          type: "health_degraded",
          source: service.name,
          isResolved: false,
        },
        data: {
          isResolved: true,
          resolvedAt: new Date(),
        },
      });
    }

    logger.info(
      `[AdminOps] Pinged service ${service.name} → ${status} (${responseTimeMs}ms)`,
    );

    return { ...updated, responseTimeMs };
  }

  // ─── Job Monitoring ──────────────────────────────────────────────────

  async listJobs({ status, jobType, jobName, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (status) where.status = status;
      if (jobType) where.jobType = jobType;
      if (jobName) where.jobName = { contains: jobName, mode: "insensitive" };
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_job_executions.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_job_executions.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listJobs error:", err.message);
      throw err;
    }
  }

  async getJob(id) {
    const job = await mainPrisma.admin_ops_job_executions.findUnique({
      where: { id },
    });
    if (!job) throw new ApiError(404, "Job execution not found");
    return job;
  }

  async trackJob(data) {
    return mainPrisma.admin_ops_job_executions.create({ data });
  }

  // ─── Dead Letter Jobs ────────────────────────────────────────────────

  async listDeadLetters({ status, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (status) where.status = status;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_dead_letter_jobs.findMany({
          where,
          skip,
          take: limit,
          orderBy: { failedAt: "desc" },
        }),
        mainPrisma.admin_ops_dead_letter_jobs.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listDeadLetters error:", err.message);
      throw err;
    }
  }

  async getDeadLetter(id) {
    const job = await mainPrisma.admin_ops_dead_letter_jobs.findUnique({
      where: { id },
    });
    if (!job) throw new ApiError(404, "Dead letter job not found");
    return job;
  }

  async resolveDeadLetter(id, adminUser) {
    await this.getDeadLetter(id);
    return mainPrisma.admin_ops_dead_letter_jobs.update({
      where: { id },
      data: {
        status: "manually_resolved",
        resolvedAt: new Date(),
        resolvedBy: adminUser.id,
      },
    });
  }

  // ─── Webhook Endpoints ───────────────────────────────────────────────

  async listWebhooks({ isActive, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (isActive !== undefined) where.isActive = isActive;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_webhook_endpoints.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            url: true,
            events: true,
            isActive: true,
            provider: true,
            description: true,
            createdAt: true,
            updatedAt: true,
            // secret intentionally excluded
          },
        }),
        mainPrisma.admin_ops_webhook_endpoints.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listWebhooks error:", err.message);
      throw err;
    }
  }

  async getWebhook(id) {
    const webhook = await mainPrisma.admin_ops_webhook_endpoints.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        url: true,
        events: true,
        isActive: true,
        provider: true,
        headers: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!webhook) throw new ApiError(404, "Webhook endpoint not found");
    return webhook;
  }

  async createWebhook(data) {
    return mainPrisma.admin_ops_webhook_endpoints.create({ data });
  }

  async updateWebhook(id, data) {
    await this.getWebhook(id);
    return mainPrisma.admin_ops_webhook_endpoints.update({
      where: { id },
      data,
    });
  }

  async deleteWebhook(id) {
    await this.getWebhook(id);
    await mainPrisma.admin_ops_webhook_endpoints.delete({ where: { id } });
  }

  // ─── Webhook Delivery Logs ───────────────────────────────────────────

  async listWebhookLogs({
    webhookEndpointId,
    status,
    event,
    page = 1,
    limit = 20,
  } = {}) {
    try {
      const where = {};
      if (webhookEndpointId) where.webhookEndpointId = webhookEndpointId;
      if (status) where.status = status;
      if (event) where.event = { contains: event, mode: "insensitive" };
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_webhook_delivery_logs.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_webhook_delivery_logs.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listWebhookLogs error:", err.message);
      throw err;
    }
  }

  async getWebhookLog(id) {
    const log = await mainPrisma.admin_ops_webhook_delivery_logs.findUnique({
      where: { id },
    });
    if (!log) throw new ApiError(404, "Webhook delivery log not found");
    return log;
  }

  // ─── Incidents ───────────────────────────────────────────────────────

  async listIncidents({ status, severity, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (status) where.status = status;
      if (severity) where.severity = severity;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_incidents.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_incidents.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listIncidents error:", err.message);
      throw err;
    }
  }

  async getIncident(id) {
    const incident = await mainPrisma.admin_ops_incidents.findUnique({
      where: { id },
    });
    if (!incident) throw new ApiError(404, "Incident not found");
    return incident;
  }

  async createIncident(data, adminUser) {
    return mainPrisma.admin_ops_incidents.create({
      data: { ...data, createdBy: adminUser.id },
    });
  }

  async updateIncident(id, data) {
    await this.getIncident(id);
    return mainPrisma.admin_ops_incidents.update({ where: { id }, data });
  }

  async resolveIncident(id, adminUser) {
    const incident = await this.getIncident(id);
    if (incident.status === "resolved" || incident.status === "closed") {
      throw new ApiError(400, "Incident is already resolved or closed");
    }
    return mainPrisma.admin_ops_incidents.update({
      where: { id },
      data: {
        status: "resolved",
        resolvedAt: new Date(),
        resolvedBy: adminUser.id,
      },
    });
  }

  // ─── System Alerts ───────────────────────────────────────────────────

  async listAlerts({
    isResolved,
    isRead,
    severity,
    page = 1,
    limit = 20,
  } = {}) {
    try {
      const where = {};
      if (isResolved !== undefined) where.isResolved = isResolved;
      if (isRead !== undefined) where.isRead = isRead;
      if (severity) where.severity = severity;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_system_alerts.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_system_alerts.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listAlerts error:", err.message);
      throw err;
    }
  }

  async getAlert(id) {
    const alert = await mainPrisma.admin_ops_system_alerts.findUnique({
      where: { id },
    });
    if (!alert) throw new ApiError(404, "Alert not found");
    return alert;
  }

  async createAlert(data) {
    return mainPrisma.admin_ops_system_alerts.create({ data });
  }

  async markAlertRead(id) {
    await this.getAlert(id);
    return mainPrisma.admin_ops_system_alerts.update({
      where: { id },
      data: { isRead: true },
    });
  }

  async resolveAlert(id) {
    await this.getAlert(id);
    return mainPrisma.admin_ops_system_alerts.update({
      where: { id },
      data: { isResolved: true, resolvedAt: new Date() },
    });
  }

  // ─── Feature Flags ───────────────────────────────────────────────────

  async listFlags({ environment, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (environment) where.environment = environment;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_feature_flags.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_feature_flags.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listFlags error:", err.message);
      throw err;
    }
  }

  async getFlag(key) {
    const flag = await mainPrisma.admin_ops_feature_flags.findUnique({
      where: { key },
    });
    if (!flag) throw new ApiError(404, "Feature flag not found");
    return flag;
  }

  async createFlag(data, adminUser) {
    try {
      return await mainPrisma.admin_ops_feature_flags.create({
        data: { ...data, createdBy: adminUser.id, updatedBy: adminUser.id },
      });
    } catch (err) {
      if (err.code === "P2002")
        throw new ApiError(409, "Feature flag key already exists");
      throw err;
    }
  }

  async updateFlag(key, data, adminUser) {
    await this.getFlag(key);
    return mainPrisma.admin_ops_feature_flags.update({
      where: { key },
      data: { ...data, updatedBy: adminUser.id },
    });
  }

  async deleteFlag(key) {
    await this.getFlag(key);
    await mainPrisma.admin_ops_feature_flags.delete({ where: { key } });
  }

  async checkFlag(key) {
    const flag = await this.getFlag(key);
    return {
      key: flag.key,
      isEnabled: flag.isEnabled,
      environment: flag.environment,
      rolloutPercentage: flag.rolloutPercentage,
    };
  }

  // ─── Health History ──────────────────────────────────────────────────

  async listHealthHistory({ status, environment, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (status) where.status = status;
      if (environment) where.environment = environment;
      const skip = (page - 1) * limit;
      const [data, total] = await Promise.all([
        mainPrisma.admin_ops_health_check_history.findMany({
          where,
          skip,
          take: limit,
          orderBy: { checkedAt: "desc" },
        }),
        mainPrisma.admin_ops_health_check_history.count({ where }),
      ]);
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listHealthHistory error:", err.message);
      throw err;
    }
  }

  async getLatestHealthCheck() {
    const record = await mainPrisma.admin_ops_health_check_history.findFirst({
      orderBy: { checkedAt: "desc" },
    });
    if (!record) throw new ApiError(404, "No health check history found");
    return record;
  }

  // ─── Environment Configs ─────────────────────────────────────────────

  async listEnvConfigs({ environment, page = 1, limit = 20 } = {}) {
    try {
      const where = {};
      if (environment) where.environment = environment;
      const skip = (page - 1) * limit;
      const [rawData, total] = await Promise.all([
        mainPrisma.admin_ops_environment_configs.findMany({
          where,
          skip,
          take: limit,
          orderBy: { createdAt: "desc" },
        }),
        mainPrisma.admin_ops_environment_configs.count({ where }),
      ]);
      // mask secrets
      const data = rawData.map((c) => ({
        ...c,
        value: c.isPublic ? c.value : "***",
      }));
      return { data, total, page, limit };
    } catch (err) {
      logger.error("[AdminOps] listEnvConfigs error:", err.message);
      throw err;
    }
  }

  async createEnvConfig(data) {
    return mainPrisma.admin_ops_environment_configs.create({ data });
  }

  async updateEnvConfig(id, data) {
    const existing = await mainPrisma.admin_ops_environment_configs.findUnique({
      where: { id },
    });
    if (!existing) throw new ApiError(404, "Config entry not found");
    return mainPrisma.admin_ops_environment_configs.update({
      where: { id },
      data,
    });
  }

  async deleteEnvConfig(id) {
    const existing = await mainPrisma.admin_ops_environment_configs.findUnique({
      where: { id },
    });
    if (!existing) throw new ApiError(404, "Config entry not found");
    await mainPrisma.admin_ops_environment_configs.delete({ where: { id } });
  }
}

module.exports = new AdminOpsService();
