import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  receivingDestination,
  receivingPixDestination,
} from "./financialSchema";

describe("separate encrypted Pix payout configuration", () => {
  it("keeps payout keys independent from receiving readiness and requires encrypted configuration", () => {
    expect(
      getTableConfig(receivingDestination).columns.some(
        (column) => column.name === "pix_configuration",
      ),
    ).toBe(false);
    const config = getTableConfig(receivingPixDestination);
    expect(config.name).toBe("receiving_pix_destination");
    expect(receivingPixDestination.pixConfiguration.dataType).toBe("json");
    expect(receivingPixDestination.pixConfiguration.notNull).toBe(true);
    expect(receivingPixDestination.state.default).toBe("PENDING");
    expect(receivingPixDestination.isCurrent.default).toBe(false);
    expect(config.foreignKeys.every((key) => key.onDelete === "restrict")).toBe(
      true,
    );
  });
});
