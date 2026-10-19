ALTER TABLE "gift_quote_record" DROP CONSTRAINT "gift_quote_allocation_check";--> statement-breakpoint
ALTER TABLE "gift_quote_record" ADD CONSTRAINT "gift_quote_allocation_check" CHECK (coalesce((
        ((( "gift_quote_record"."snapshot" #> '{quote,feeAllocation}' IS NULL
             AND "gift_quote_record"."snapshot" #> '{pricing,policy,feeAllocation}' IS NULL)
           OR ("gift_quote_record"."snapshot" #> '{quote,feeAllocation}' = '"BUYER_GROSS_UP"'::jsonb
               AND "gift_quote_record"."snapshot" #> '{pricing,policy,feeAllocation}' = '"BUYER_GROSS_UP"'::jsonb))
          AND "gift_quote_record"."total_cents"::bigint = "gift_quote_record"."nominal_cents"::bigint + "gift_quote_record"."commission_cents"::bigint + "gift_quote_record"."processing_cents"::bigint)
        OR ("gift_quote_record"."snapshot" #> '{quote,feeAllocation}' = '"RECIPIENT_DEDUCTED"'::jsonb
            AND "gift_quote_record"."snapshot" #> '{pricing,policy,feeAllocation}' = '"RECIPIENT_DEDUCTED"'::jsonb
            AND "gift_quote_record"."total_cents"::bigint = "gift_quote_record"."nominal_cents"::bigint
            AND "gift_quote_record"."total_cents"::bigint > "gift_quote_record"."commission_cents"::bigint + "gift_quote_record"."processing_cents"::bigint)
      ), false));