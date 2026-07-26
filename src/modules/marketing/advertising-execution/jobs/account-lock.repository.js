const { prisma } = require("../../../../shared/config/database");
const { executionError } = require("../execution.errors");

function accountLockKey({ platform, connectionId, accountExternalId }) { return `${String(platform).toUpperCase()}:${String(connectionId).toLowerCase()}:${String(accountExternalId)}`; }
class AccountLockRepository {
  constructor({ client = prisma, now = () => new Date() } = {}) { this.client = client; this.now = now; }
  async acquire({ platform, connectionId, accountExternalId, owner, leaseSeconds = 60 }) {
    const key = accountLockKey({ platform, connectionId, accountExternalId }); const expiresAt = new Date(this.now().getTime() + leaseSeconds * 1000);
    return this.client.$transaction(async (tx) => {
      await tx.marketingExecutionAccountLock.deleteMany({ where: { key, expiresAt: { lt: this.now() } } });
      try { return await tx.marketingExecutionAccountLock.create({ data: { key, platform, connectionId, accountExternalId, owner, expiresAt } }); }
      catch (error) { if (error?.code === "P2002") throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "ACCOUNT_EXECUTION_LOCKED" }); throw error; }
    });
  }
  async heartbeat({ key, owner, leaseSeconds = 60 }) { const result = await this.client.marketingExecutionAccountLock.updateMany({ where: { key, owner, expiresAt: { gt: this.now() } }, data: { expiresAt: new Date(this.now().getTime() + leaseSeconds * 1000) } }); if (result.count !== 1) throw executionError("INVALID_OPERATION_TRANSITION", { reasonCode: "ACCOUNT_LOCK_OWNER_MISMATCH" }); return true; }
  async release({ key, owner }) { return this.client.marketingExecutionAccountLock.deleteMany({ where: { key, owner } }); }
  async isOwned({ key, owner }) { return Boolean(await this.client.marketingExecutionAccountLock.findFirst({ where: { key, owner, expiresAt: { gt: this.now() } } })); }
}
module.exports = { accountLockKey, AccountLockRepository };
