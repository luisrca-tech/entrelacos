import {
  type GiftCreateInput,
  type GiftItem,
  type GiftUpdateInput,
  giftCatalogResponseSchema,
  giftCreateInputSchema,
  giftItemResponseSchema,
  giftItemSchema,
  giftPublishInputSchema,
  giftReorderInputSchema,
  giftUpdateInputSchema,
  siteIdSchema,
} from "@entrelacos/contracts";
import { apiRequest } from "../lib/apiClient";

type Request = (
  path: string,
  options?: { method?: string; body?: unknown },
) => Promise<unknown>;
export class GiftCatalogClient {
  private readonly siteId: string;
  private readonly path: string;
  constructor(
    siteId: string,
    private readonly request: Request = apiRequest,
  ) {
    this.siteId = siteIdSchema.parse(siteId);
    this.path = `/v1/sites/${encodeURIComponent(this.siteId)}/gifts`;
  }
  private gift(value: unknown, giftId?: string): GiftItem {
    const { gift } = giftItemResponseSchema.parse(value);
    if (
      gift.siteId !== this.siteId ||
      (giftId !== undefined && gift.id !== giftId)
    )
      throw new Error("Unexpected catalog gift");
    return gift;
  }
  private catalog(value: unknown): GiftItem[] {
    const { gifts } = giftCatalogResponseSchema.parse(value);
    if (
      gifts.some((gift) => gift.siteId !== this.siteId) ||
      new Set(gifts.map((gift) => gift.id)).size !== gifts.length
    )
      throw new Error("Unexpected catalog scope");
    return gifts;
  }
  async list(): Promise<GiftItem[]> {
    return this.catalog(await this.request(this.path));
  }
  async create(input: GiftCreateInput): Promise<GiftItem> {
    const body = giftCreateInputSchema.parse(input);
    return this.gift(await this.request(this.path, { method: "POST", body }));
  }
  async update(giftId: string, input: GiftUpdateInput): Promise<GiftItem> {
    giftItemSchema.shape.id.parse(giftId);
    const body = giftUpdateInputSchema.parse(input);
    return this.gift(
      await this.request(`${this.path}/${encodeURIComponent(giftId)}`, {
        method: "PATCH",
        body,
      }),
      giftId,
    );
  }
  async publication(
    giftId: string,
    publicationState: GiftItem["publicationState"],
  ): Promise<GiftItem> {
    giftItemSchema.shape.id.parse(giftId);
    const body = giftPublishInputSchema.parse({ publicationState });
    return this.gift(
      await this.request(
        `${this.path}/${encodeURIComponent(giftId)}/publication`,
        { method: "PATCH", body },
      ),
      giftId,
    );
  }
  async reorder(giftIds: string[]): Promise<GiftItem[]> {
    const body = giftReorderInputSchema.parse({ giftIds });
    return this.catalog(
      await this.request(`${this.path}/reorder`, { method: "POST", body }),
    );
  }
}
