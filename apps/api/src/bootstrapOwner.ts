import { randomUUID } from "node:crypto";
import { account, user } from "@entrelacos/database/schema";
import { hashPassword } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface BootstrapOwnerInput {
  email: string;
  name: string;
  password: string;
}

export interface BootstrapOwnerResult {
  created: boolean;
  userId: string;
}

export type BootstrapDatabase = NodePgDatabase<Record<string, never>>;

function validateInput(input: BootstrapOwnerInput): {
  email: string;
  name: string;
} {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();

  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error("Owner email is invalid");
  }
  if (!name) {
    throw new Error("Owner name is required");
  }
  if (input.password.length < 8) {
    throw new Error("Owner password must contain at least 8 characters");
  }

  return { email, name };
}

export async function bootstrapOwner(
  db: BootstrapDatabase,
  input: BootstrapOwnerInput,
): Promise<BootstrapOwnerResult> {
  const { email, name } = validateInput(input);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);

    if (existing) {
      if (existing.role === "OWNER") {
        return { created: false, userId: existing.id };
      }
      throw new Error(
        "Owner bootstrap email is already used by a non-owner account",
      );
    }

    const userId = randomUUID();
    const now = new Date();
    const password = await hashPassword(input.password);

    await tx.insert(user).values({
      id: userId,
      name,
      email,
      emailVerified: true,
      role: "OWNER",
      state: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(account).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      password,
      createdAt: now,
      updatedAt: now,
    });

    return { created: true, userId };
  });
}
