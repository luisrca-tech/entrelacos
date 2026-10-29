# Gift pricing settlement

Settlement retains the immutable quote and the authenticated provider allocation separately. `processingCents` in the payment record is the observed gross less the provider net; the settled fixed platform commission is deducted from that net to determine the recipient credit. Reconciliation does not rewrite the quote or invent an absorption adjustment.

An explicitly marked `BUYER_GROSS_UP` quote requires the actual processing amount to match the quoted processing amount. A difference in either direction returns `DIVERGENT` / `ALLOCATION_MISMATCH`, retains the observed payment amounts, and creates no receipt effect. The existing posting repository persists those observed amounts and retries the event with `last_error_code = ALLOCATION_MISMATCH`. This does not authorize gross-up checkout: external account guarantees and the difference policy remain separate release gates.

For `RECIPIENT_DEDUCTED`, the recipient receives the actual provider net less the settled platform commission, provided all existing allocation and receipt checks succeed. The quote's processing estimate and the payment's actual processing amount remain separately persisted, so their difference can be identified without suppressing a legitimate receipt. A quote processing amount of zero can be a pricing placeholder; it is not proof that the provider charges no processing fee.

Historical snapshots without `feeAllocation` preserve the existing actual-net receipt behavior. An absent field is not retroactively classified as an explicitly approved gross-up policy.

## Listening

The selected change makes an explicit gross-up mismatch visible through the existing divergence/retry path while preserving recipient-deducted and historical receipts. Rejecting every processing difference would block legitimate recipient credits; changing historical snapshots or assigning the difference to the platform would invent policy. A distinct recipient divergence event alongside a posted receipt would require an approved reporting policy and changes to the downstream result and persistence model; this change adds neither.
