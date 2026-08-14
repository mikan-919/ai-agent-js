import type { DeviceRecord } from "@mikan-919/oriel-contracts";
import { DurableObject } from "cloudflare:workers";

export interface IssueCodeInput {
  codeHash: string;
  codeChallenge: string;
  state: string;
  purpose: "registration" | "management";
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  expiresAt: number;
}

export interface ConsumedCode {
  codeChallenge: string;
  state: string;
  purpose: "registration" | "management";
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  expiresAt: number;
}

export interface RegisterDeviceInput {
  deviceId: string;
  deviceTokenHash: string;
  cancellationTokenHash: string;
  cancellationExpiresAt: number;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  registeredAt: number;
}

interface DeviceRow extends Record<string, SqlStorageValue> {
  device_id: string;
  installation_id: number;
  repository_id: number;
  repository_owner: string;
  repository_name: string;
  registered_at: number;
  revoked_at: number | null;
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repository: { owner: row.repository_owner, name: row.repository_name },
    registeredAt: row.registered_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * repository単位のデバイス登録簿。tokenのhash、経路制御に要るID、表示metadata、
 * 登録日時と失効日時だけをDurable ObjectのSQLiteへ永続化する。
 *
 * 短命codeはhashで保存し、`DELETE ... RETURNING`の単一文で一度だけ消費する。
 */
export class DeviceRegistryObject extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS registration_codes (
          code_hash TEXT PRIMARY KEY,
          code_challenge TEXT NOT NULL,
          state TEXT NOT NULL,
          purpose TEXT NOT NULL,
          installation_id INTEGER NOT NULL,
          repository_id INTEGER NOT NULL,
          repository_owner TEXT NOT NULL,
          repository_name TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          device_token_hash TEXT NOT NULL UNIQUE,
          installation_id INTEGER NOT NULL,
          repository_id INTEGER NOT NULL,
          repository_owner TEXT NOT NULL,
          repository_name TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS device_cancellations (
          device_id TEXT PRIMARY KEY,
          cancellation_token_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    });
  }

  issueCode(input: IssueCodeInput): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO registration_codes
       (code_hash, code_challenge, state, purpose, installation_id, repository_id,
        repository_owner, repository_name, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.codeHash,
      input.codeChallenge,
      input.state,
      input.purpose,
      input.installationId,
      input.repositoryId,
      input.repositoryOwner,
      input.repositoryName,
      input.expiresAt,
    );
  }

  /** codeを一度だけ消費する。失敗した交換もcodeを使い切る。 */
  consumeCode(codeHash: string): ConsumedCode | null {
    const [row] = this.ctx.storage.sql
      .exec<{
        code_challenge: string;
        state: string;
        purpose: string;
        installation_id: number;
        repository_id: number;
        repository_owner: string;
        repository_name: string;
        expires_at: number;
      }>(
        `DELETE FROM registration_codes WHERE code_hash = ? RETURNING *`,
        codeHash,
      )
      .toArray();

    if (row === undefined) {
      return null;
    }

    return {
      codeChallenge: row.code_challenge,
      state: row.state,
      purpose: row.purpose === "management" ? "management" : "registration",
      installationId: row.installation_id,
      repositoryId: row.repository_id,
      repositoryOwner: row.repository_owner,
      repositoryName: row.repository_name,
      expiresAt: row.expires_at,
    };
  }

  registerDevice(input: RegisterDeviceInput): DeviceRecord {
    this.ctx.storage.sql.exec(
      `INSERT INTO devices
       (device_id, device_token_hash, installation_id, repository_id,
        repository_owner, repository_name, registered_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      input.deviceId,
      input.deviceTokenHash,
      input.installationId,
      input.repositoryId,
      input.repositoryOwner,
      input.repositoryName,
      input.registeredAt,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO device_cancellations (device_id, cancellation_token_hash, expires_at)
       VALUES (?, ?, ?)`,
      input.deviceId,
      input.cancellationTokenHash,
      input.cancellationExpiresAt,
    );

    return {
      deviceId: input.deviceId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      repository: {
        owner: input.repositoryOwner,
        name: input.repositoryName,
      },
      registeredAt: input.registeredAt,
      revokedAt: null,
    };
  }

  /** 接続認証。失効したdeviceは解決せず、新しい接続を拒否させる。 */
  authenticateDevice(deviceTokenHash: string): DeviceRecord | null {
    const [row] = this.ctx.storage.sql
      .exec<DeviceRow>(
        `SELECT device_id, installation_id, repository_id, repository_owner,
                repository_name, registered_at, revoked_at
         FROM devices WHERE device_token_hash = ? AND revoked_at IS NULL`,
        deviceTokenHash,
      )
      .toArray();

    return row === undefined ? null : toDeviceRecord(row);
  }

  listDevices(): DeviceRecord[] {
    return this.ctx.storage.sql
      .exec<DeviceRow>(
        `SELECT device_id, installation_id, repository_id, repository_owner,
                repository_name, registered_at, revoked_at
         FROM devices ORDER BY registered_at, device_id`,
      )
      .toArray()
      .map(toDeviceRecord);
  }

  revokeDevice(deviceId: string, revokedAt: number): DeviceRecord | null {
    const [row] = this.ctx.storage.sql
      .exec<DeviceRow>(
        `UPDATE devices SET revoked_at = COALESCE(revoked_at, ?)
         WHERE device_id = ?
         RETURNING device_id, installation_id, repository_id, repository_owner,
                   repository_name, registered_at, revoked_at`,
        revokedAt,
        deviceId,
      )
      .toArray();

    if (row === undefined) {
      return null;
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM device_cancellations WHERE device_id = ?`,
      deviceId,
    );

    return toDeviceRecord(row);
  }

  /**
   * 発行直後の登録を取り消す内部限定の経路。取消証明はそのdeviceだけに結び付き、
   * 短命で、一度使うと消える。他のdeviceは取り消せない。
   */
  cancelIssuedDevice(input: {
    deviceId: string;
    cancellationTokenHash: string;
    now: number;
  }): "cancelled" | "unknown_device" | "invalid_cancellation_proof" {
    const [row] = this.ctx.storage.sql
      .exec<{ cancellation_token_hash: string; expires_at: number }>(
        `SELECT cancellation_token_hash, expires_at FROM device_cancellations WHERE device_id = ?`,
        input.deviceId,
      )
      .toArray();

    if (row === undefined) {
      return "unknown_device";
    }

    if (
      row.cancellation_token_hash !== input.cancellationTokenHash ||
      row.expires_at < input.now
    ) {
      return "invalid_cancellation_proof";
    }

    return this.revokeDevice(input.deviceId, input.now) === null
      ? "unknown_device"
      : "cancelled";
  }

  /** 期限切れのcodeと取消証明を掃除する。失効済deviceの記録は残す。 */
  purgeExpired(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM registration_codes WHERE expires_at < ?`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM device_cancellations WHERE expires_at < ?`,
      now,
    );
  }
}
