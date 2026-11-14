# Sonda de antecipação — split V2 na conta principal (Sandbox do Asaas)

Datas: 2026-11-13 e 2026-11-14 · Ambiente: **somente Sandbox** · Valores em centavos quando
não indicado.

Decisão de 2026-11-14 (Luis): antecipação automática de cartão ligada na conta principal,
com taxa de 1,15% a.m. no 1x e 1,6% a.m. no parcelado. O convidado paga a taxa do meio de
pagamento, a antecipação (só no cartão) e 2% de serviço. O casal recebe 100% do presente.
Pix não é antecipado. Não há feature flag. As cobranças V1 seguem no modelo antigo.

## 1. Preço sem margem de antecipação é recusado (2026-11-13)

Presente V2 de R$ 150 em 3x, criado pelo fluxo de Dev com as tarifas sem antecipação
(total R$ 159,05, parcelas 53,01 / 53,01 / 53,03, split 50,00 / 49,99 / 50,01).

- Tentativa `68f7a493-5007-48fc-8edb-e73efc2e3434`, parcelamento
  `5da02a4b-7581-471c-ac25-e93de5c58970`.
- Simulação do parcelamento: taxa R$ 5,66, líquido R$ 148,97 (menor que os R$ 150 do casal).
- Simulação da parcela 2: taxa R$ 1,93, líquido R$ 49,61 (menor que o split de R$ 49,99).
- `POST /v3/anticipations` foi recusado tanto para o parcelamento quanto para a parcela 2:
  *"O valor do Split é superior ao valor antecipado."*
- Nenhum webhook chegou para essas recusas, e o presente continuou CONFIRMED, sem crédito
  e sem alerta.

Com a margem da fórmula antiga (3x de R$ 164,28 com split de R$ 150), o Asaas **aceitou**
a antecipação:

- parcelamento inteiro: `a95740e3-a78c-47d9-8602-f03870ec740a`, taxa R$ 5,86, líquido R$ 153,86;
- parcela avulsa: `a9548507-7c7b-468b-9107-279ebf5469fa`, taxa R$ 1,99, líquido R$ 51,25.

As duas ficaram PENDING. As sondas geraram em Dev alertas `UNROUTABLE_PLATFORM_EVENT`, o
que é esperado, porque elas não têm presente correspondente.

Conclusão: o Asaas exige que o líquido antecipado de cada parcela cubra o split dela. Por
isso o preço precisa embutir a antecipação.

## 2. Antecipação automática com o preço novo (2026-11-14)

Parcelamento 3x de R$ 164,29 (preço V2 novo de R$ 150 em 3x), pago com o cartão de teste às
12:45. O split por parcela é o da cotação: 50,91 / 50,00 / 49,09.

- Parcelamento: `447e4aa5-a769-4761-8dba-4b27445734e7`.
- O Asaas criou sozinho **uma antecipação para cada parcela**, inclusive a 2ª e a 3ª, menos
  de 5 minutos depois do pagamento. A `requestDate` e a `anticipationDate` são do mesmo dia.
- As três antecipações continuaram **PENDING** por 30 minutos (6 checagens). O Sandbox não
  aprova nem credita antecipações: a documentação só lista "solicitar" e "listar" como
  testáveis, e não existe endpoint de aprovação.

| Parcela | Cobrança | Valor | Líquido do cartão (Sandbox) | Dias | Taxa de antecipação | Líquido antecipado | Split do casal | Folga |
|---|---|---|---|---|---|---|---|---|
| 1 | `pay_0_0ec9mclnnogq20` (`a5075caf-…`) | 54,76 | 53,24 | 32 | 0,91 | 52,33 | 50,91 | 1,42 |
| 2 | `pay_0_l7zvr987404z6g` (`ee1dc7c7-…`) | 54,76 | 53,24 | 65 | 1,85 | 51,39 | 50,00 | 1,39 |
| 3 | `pay_0_vgo3bt0itx1di3` (`d313b7c9-…`) | 54,77 | 53,25 | 96 | 2,73 | 50,52 | 49,09 | 1,43 |

As taxas batem com 1,6% × líquido × dias / 30 (por exemplo, 53,24 × 1,6% × 32 / 30 = 0,91).

Antecipações automáticas que já existiam, de cobranças pagas antes da ativação, só cobriam a
1ª parcela. Exemplos:

- `pay_0_csklhpqw7fr0mt`: taxa 0,85, líquido 50,69, split 50,00;
- `pay_0_mrwssjp7om7kp6`: idem.

Elas não foram alteradas.

## 3. Validação numérica das cotações contra o Asaas

Para R$ 50, R$ 150, R$ 500 e R$ 2.000 em 1x, 2x, 3x, 6x, 7x e 12x, a cotação foi gerada por
`quoteGiftV2`. Em seguida foi criada a cobrança de cartão no Sandbox (sem pagar) e simulada
a antecipação de cada parcela (`POST /v3/anticipations/simulate`).

R$ 50 em 12x não é oferecido, porque a parcela de 4,98 fica abaixo do mínimo de R$ 5. Os
outros 23 cenários somam 112 parcelas:

- todas as parcelas que o Asaas gerou coincidem com as da cotação (o resto da divisão fica na
  última parcela);
- **líquido antecipado ≥ split em 112 de 112 parcelas**, nas duas contas abaixo:
  - **Sandbox:** taxa promocional do cartão (1,99% / 2,49% / 2,99% até 2027-01-16), com a
    taxa de antecipação que o Asaas simulou;
  - **Tarifa cheia:** 2,99% / 3,49% / 3,99% + R$ 0,49 rateado, com antecipação de 1,15% /
    1,6% a.m. sobre os dias simulados.
- A menor folga com a tarifa cheia foi de 10 centavos (R$ 50 em 7x). Para R$ 150 em 12x ela
  foi de 12 centavos.

R$ 150, folga de cada parcela com a tarifa cheia:

| Opção | Preço do convidado | Antecipação estimada | Parcela | Dias | Taxa (Sandbox) | Líquido (Sandbox) | Líquido (tarifa cheia) | Split |
|---|---|---|---|---|---|---|---|---|
| 1x | 160,06 | 1,78 | 1 | 32 | 1,92 | 154,47 | 152,88 | 150,00 |
| 3x | 164,29 | 5,06 | 1 | 32 | 0,91 | 52,33 | 51,79 | 50,91 |
| | | | 2 | 65 | 1,85 | 51,39 | 50,86 | 50,00 |
| | | | 3 | 96 | 2,73 | 50,52 | 50,00 | 49,09 |
| 12x | 178,37 | 17,76 | 1 | 32 | 0,25 | 14,13 | 13,99 | 13,87 |
| | | | 6 | 192 | 1,47 | 12,91 | 12,77 | 12,62 |
| | | | 12 | 384 | 2,96 | 11,47 | 11,36 | 11,17 |

Dias de crédito simulados para 12x: 32, 65, 96, 128, 160, 192, 226, 256, 289, 320, 352 e 384.
O código supõe, de forma conservadora, `33·i + 5` dias (38 … 401) para ratear o split, o que
dá de 5 a 17 dias de folga para fins de semana e feriados. O total cobrado segue o `sim.py`
(meses de 30 dias). A pequena diferença nos dias reais é absorvida pela margem do serviço
de 2%, e nunca pela parte do casal.

## 4. Comportamento do código (branch `feat/split-v2-automatic-anticipation`)

- **Tarifas** (`giftTariffs.ts`, versão `platform-tariffs-2026-11-14`): antecipação de 115
  pontos-base no 1x e de 160 no 2x a 12x; Pix sem antecipação.
- **Leitura do Asaas:** `getPayment` mantém o campo `anticipated`. Quando ele vem `true`, a
  API lê `GET /v3/anticipations?payment=` e guarda o id, o status e a taxa real.
- **Crédito do casal:**
  - `PAYMENT_SPLIT_DONE` credita quando a cobrança está RECEIVED, ou CONFIRMED com
    `anticipated: true` (o split é pago quando a antecipação é processada).
  - Sem antecipação, a parcela espera RECEIVED, como antes.
  - Se a antecipação for negada (`RECEIVABLE_ANTICIPATION_DENIED`), sai um alerta de aviso e
    a parcela segue o fluxo normal, sem perda para o casal.
- **Eventos `RECEIVABLE_ANTICIPATION_*`:** são roteados pelo `anticipation.payment` ou
  `anticipation.installment` para o presente V2 e registram a taxa real sem gerar um novo
  crédito.
- **Contabilidade:**
  - `commission_cents` continua igual a líquido − split, e mantém a conservação
    gross = processamento + comissão + parte do casal;
  - `platform_net_cents` desconta a taxa real de antecipação.
- **Resumo do casal:** passa a aceitar crédito V2 em CONFIRMED (antes respondia 503).
- **Financeiro Entrelaços:** coluna de antecipação estimada × real, totais estimado e real, e
  comissão líquida real = soma de `platform_net_cents` das parcelas creditadas.

## 5. O que ficou sem verificar

- **Aprovação e crédito no Sandbox:** o Sandbox não aprova nem credita antecipações. Por isso
  não foram observados os eventos `RECEIVABLE_ANTICIPATION_CREDITED`, o `PAYMENT_SPLIT_DONE`
  de uma parcela antecipada, nem o crédito do casal com a cobrança ainda CONFIRMED. Isso está
  coberto por testes com o formato documentado do payload e precisa ser conferido na
  primeira cobrança real.
- **Prazo de "até 2 dias úteis":** vem da decisão comercial e ainda não foi medido. O texto
  público diz "normalmente" e "sujeito à análise do Asaas".
- **Saída do crédito com anticipated=true:** não sabemos se, na produção, uma parcela
  antecipada fica CONFIRMED com `anticipated: true` até a data de crédito ou se vira
  RECEIVED. O código aceita os dois casos.
- **Tarifa promocional:** o Sandbox aplica a tarifa promocional até 2027-01-16. Com a tarifa
  cheia, a menor folga cai para 10 centavos por parcela, ainda positiva.
