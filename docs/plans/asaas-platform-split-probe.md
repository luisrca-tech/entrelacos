# Sonda do Slice 0 — split da conta principal no Sandbox do Asaas

Data: 2026-11-13 · Ambiente: **somente Sandbox** (chave `$aact_hmlg_` da conta principal) ·
Script: `apps/api/scripts/probePlatformSplit.ts`

Valores usados seguem o adendo sem antecipação (`sim.py` com `mrate = 0`):
Pix R$ 100 → R$ 103,99; cartão 1x → R$ 105,65; cartão 12x → R$ 106,75.

## Configuração observada na conta principal (Sandbox)

- `GET /myAccount/fees/`: cartão 2,99% / 3,49% / 3,99% + R$ 0,49 e Pix R$ 1,99, iguais à
  tabela `giftTariffs.ts`. **Mas** a conta tem desconto promocional ativo até 2027-01-16
  (`hasValidDiscount: true`: 1,99% / 2,49% / 2,99% e Pix R$ 0,99), e é esse desconto que o
  Asaas aplicou nas cobranças abaixo. A fórmula usa as tarifas cheias, então a diferença
  fica com a plataforma e nunca falta para o casal.
- `daysToReceive` do cartão: 32.
- A antecipação automática de cartão estava **ligada** no Sandbox
  (`creditCardAutomaticEnabled: true`). Ela foi desligada com
  `probePlatformSplit.ts disable-automatic-anticipation`, para espelhar o modelo V2,
  que não usa antecipação.

## Respostas

### (a) R$ 0,49 é cobrado por parcela ou por parcelamento?

**Por parcelamento, rateado entre as parcelas.** Parcelamento 12x de R$ 106,75
(`installment a8b7663a-c3fb-4e41-854c-817fddf935da`):

| Parcela | Valor | Líquido | Taxa |
|---|---|---|---|
| 1–11 | R$ 8,89 | R$ 8,59 | R$ 0,30 |
| 12 | R$ 8,96 | R$ 8,66 | R$ 0,30 |

R$ 0,30 ≈ 2,99% × 8,89 (R$ 0,27) + R$ 0,49 / 12 (R$ 0,04). Se os R$ 0,49 caíssem em
cada parcela, a taxa seria ≈ R$ 0,76. Se caíssem só na 1ª, a 1ª teria taxa ≈ R$ 0,76 e
as demais ≈ R$ 0,27. A taxa total do parcelamento (R$ 3,60) é menor que o modelo da
fórmula (3,99% + R$ 0,49 = R$ 4,75), então o total cotado continua cobrindo o casal.

Consequência no código: o cronograma `giftSplitScheduleV2` passa a ratear a taxa fixa
entre as parcelas em vez de lançá-la toda na 1ª (a premissa "[SUPOSIÇÃO] só na 1ª" da
spec b.4 não se confirmou, mas também não é o caso "por parcela" que exigiria parar).

1x pago com cartão (`pay_0_h0kyl2j7izswco`): R$ 105,65 → líquido R$ 103,06
(1,99% + R$ 0,49 com o desconto promocional).

### (b) O PUT de split funciona nas parcelas filhas?

**Sim.** O `POST /payments` com `split.totalFixedValue = 100` gerou 12 filhas com
`fixedValue` 8,33 × 11 + 8,37. Os 12 `PUT /payments/{id}` com
`{billingType, value, dueDate, split:[{walletId, fixedValue}]}` responderam 200, e o
`GET /installments/{id}/payments` seguinte confirmou o valor de cada filha
(`[8,33 ×9, 8,32, 8,32, 8,39]`, soma R$ 100). Depois do PUT, o pagamento da 1ª
parcela com cartão (`payWithCreditCard`) confirmou todas as 12 parcelas (`CONFIRMED`),
mantendo os splits.

As filhas herdam `externalReference` do `POST /payments` (todas vieram com
`probe-12x`), o que viabiliza o roteamento do webhook por `externalReference`.

### (c) Quando sai o `PAYMENT_SPLIT_DONE` de cada parcela, sem antecipação?

- **Pix** (`pay_0_yrvyerbkaro1l5`, R$ 103,99, split fixo R$ 100): confirmado no Sandbox por
  `POST /sandbox/payment/{id}/confirm` → `RECEIVED` com `creditDate` no mesmo dia e split
  `DONE` imediatamente (líquido R$ 103,00 com a tarifa promocional).
- **Cartão**: após a confirmação, cada parcela fica `CONFIRMED` com o split em
  `PENDING` e, depois, `AWAITING_CREDIT`. A `creditDate` de cada parcela é a data em que
  ela vira `RECEIVED` e o split passa a `DONE`:
  - 1x: 2026-12-15 (32 dias corridos após a confirmação em 2026-11-13).
  - 12x: 2026-12-15, 2027-01-18, 2027-02-17, 2027-03-22, 2027-04-22, 2027-05-24,
    2027-06-25, 2027-07-27, 2027-08-30, 2027-09-29, 2027-11-01, 2027-12-02, ou seja,
    uma parcela a cada ~30–33 dias (dia útil).
- O Sandbox **não** permite adiantar esse crédito: `POST /sandbox/payment/{id}/confirm`
  numa cobrança de cartão já confirmada responde 400 `invalid_action`
  ("Cobrança já confirmada"). Por isso o crédito do casal no cartão não pode ser
  observado ponta a ponta no mesmo dia; ele é coberto por testes com o payload de
  `PAYMENT_SPLIT_DONE` e deve ser conferido em 2026-12-15 com
  `probePlatformSplit.ts observe` sobre os IDs abaixo.

## IDs do Sandbox

| Cenário | ID |
|---|---|
| Carteira do casal (subconta Sandbox) | `4bedd2f7-…` |
| 1x cartão | `pay_0_h0kyl2j7izswco` |
| 12x parcelamento | `a8b7663a-c3fb-4e41-854c-817fddf935da` |
| 12x parcela 1 | `pay_0_0bvvn32pjkdbil` |
| 12x parcela 12 | `pay_0_eylq90h7imm6l4` |
| Pix | `pay_0_yrvyerbkaro1l5` |

## Pendências

- Conferir em 2026-12-15 o `PAYMENT_SPLIT_DONE` da 1x e da 1ª parcela do 12x.
- Confirmar com o Asaas se a conta de produção também rateia os R$ 0,49 e se tem o mesmo
  desconto promocional (o modelo usa a tarifa cheia, o que é conservador).
