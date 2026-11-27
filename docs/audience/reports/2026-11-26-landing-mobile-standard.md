# Audience panel — landing (mobile) · standard · 2026-11-26

- **Piece:** live landing `https://entrelacosbr.site/?utm_source=instagram&utm_medium=paid`, home page only (`/duvidas` was not shown to the panel).
- **Capture:** 390×844 (iPhone 14 profile), 11 screenshots top to bottom; cookie notice shown once and declined; all six home FAQ items opened. Folder (session scratchpad, not committed): `/tmp/claude-1000/-home-lfrca-projetos-personal-projects-entrelacos/092e5da4-8078-4a75-95c3-fcb840c52f22/scratchpad/cap`.
- **Tier:** standard — P01–P10, one Sonnet sample each, one Opus rater with anchor set A. Chosen because the piece is a landing and ten personas cover all five segments twice.
- **Audience:** [`docs/audience/entrelacos.md`](../entrelacos.md) version 1 (assumption-heavy: no analytics or customer data yet).
- **Decision asked:** "Você chamaria o Entrelaços no WhatsApp pra pedir o orçamento do site do seu casamento (ou mandaria pra alguém que vai casar)?"
- **Raw material:** [`2026-11-26-landing-mobile-standard/`](./2026-11-26-landing-mobile-standard/) (responses, ratings, weights, id map).

> Synthetic panel: directional only. Validate the top 1–2 fixes with real people or an A/B test.

## Constructs (weighted, 1–5)

| construct | overall mean | overall top-2 | buyers S1+S2+S3 | S1 | S2 | S3 | S4 assessoras | S5 non-buyers |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comprehension | 3.31 | 38% | 3.31 | 3.42 | 3.35 | 3.10 | 3.40 | 3.20 |
| relevance | 3.73 | 65% | 3.97 | 4.42 | 3.47 | 3.70 | 3.45 | 2.70 |
| **trust** | **2.43** | **4%** | 2.46 | 2.57 | 2.30 | 2.43 | 2.75 | 2.05 |
| intent | 3.07 | 34% | 3.18 | 3.43 | 2.90 | 3.00 | 2.75 | 2.75 |

Reading: the page finds the right people (S1 relevance 4.42) and they understand the offer in broad terms, but **trust is the blocking construct**: almost nobody (4%) reaches "seems trustworthy". Intent sits at "maybe": most would ask a question on WhatsApp, not request a quote with conviction. The premium segment (S2) is the least convinced among buyers.

## Themes (weighted share of personas)

| # | theme | share | segments | screen |
| --- | --- | --- | --- | --- |
| 1 | No proof that anyone real uses it, and no one behind the brand | 100% | all | 03–07 demos, 06 mural, 11 footer |
| 2 | Gift fee is mentioned but never quantified; who pays it is unclear | 100% | all | 08 gifts, 10 FAQ |
| 3 | "A partir de R$ 300" raises more questions than it answers | 100% | all | 09 process, 11 FAQ |
| 4 | No delivery time | 75% | S1, S2, S3, S4 | 09 process |
| 5 | "Recebimento sujeito à verificação de identidade" sounds like money gets stuck | 63% | S1, S2, S3 | 08 gifts |
| 6 | Why pay when free alternatives exist (iCasei, Pix direto, grupo de WhatsApp) | 48% | S1, S3, S5 | whole page |
| 7 | Guest experience not shown: PIN for elderly guests, the gift list as the guest sees it | 39% | S1, S3, S4, S5 | 06 guests |
| 8 | Premium buyers see "two templates" and a price that feels too cheap for exclusivity | 20% (all of S2) | S2 | 03–05 models |

Quotes:

1. *"Não vi depoimento de casal de verdade, o mural é 'mensagem ilustrativa', e não sei quem são vocês."* (P01, S1) · *"Golpe, né. Não tem endereço, nome de gente, CNPJ, nem depoimento de casal de verdade."* (P05, S5) · *"Eu trabalho com marketing, sei quando é só vitrine... Zero caso real, zero casal que usou."* (P08, S2)
2. *"'Taxas e parcelas aparecem antes do pagamento' não me diz nada."* (P01) · *"Eu já recebo Pix direto na minha chave sem pagar nada, então se tiver desconto eu perco dinheiro."* (P03, S3)
3. *"R$ 300 é 'a partir de', então não sei quanto custa de verdade. Não sei se é pago uma vez ou todo mês."* (P10) · *"'A partir de' é aquela coisa... Se eu não tivesse que conversar pra saber o preço, eu fecharia mais rápido."* (P06)
4. *"Meu casamento é daqui a 4 meses, quanto tempo eles levam pra entregar? Fala em 'prazo combinado pelo WhatsApp', mas não dá nem uma ideia."* (P07)
5. *"'Recebimento sujeito à verificação de identidade' me deixou com dúvida de se vai travar meu dinheiro."* (P01)
6. *"Não ficou claro por que isso é melhor que o iCasei, que é grátis e já tem lista. Ninguém compara."* (P01)
7. *"Como minha vó vai receber e usar isso? Ela mal usa o WhatsApp."* (P09) · *"Não vi a lista de presentes em si... queria ver como o convidado enxerga."* (P01)
8. *"R$ 300 me soa barato demais... Template com cor trocada é o que parece."* (P08) · *"Pra mim isso parece barato demais pra ser exclusivo."* (P02)

What pulled them in (keep it): the elegant visual (everyone), "nós preparamos o site" (P01, P02, P06, P07), the family-by-family confirmation panel (P04, P06, P07, P09, P10), guests without an account (P01, P05, P06, P09), the Pagar.me/Stone seal (P01, P05, P08, P09), and showing a price at all (P03, P04, P05, P07, P10). The always-visible WhatsApp button helped P02, P07 and P09; only P06 found it pushy.

Isolated remarks: assessoras find nothing addressed to them, no partner terms and no access for themselves (P04); no privacy policy, data export or "what happens after the wedding" (P06, P02, P09); no promise of support on the wedding day (P08); no section for venue, lodging and directions in the demos as shown (P07); vocabulary such as "painel", "moderar", "PIN" and "contribuições" feels technical (P09, P05); the "Cinema Botânico" preview looks static, so the video promise is not felt (P08); the gift-box illustration looks crooked (P10); a lot of scrolling for a phone at 3 a.m. (P07).

## Key finding: the best answer is hidden on `/duvidas`

`/duvidas` already says **"Quanto o casal recebe? 100% do valor cadastrado... o convidado paga as taxas e o serviço Entrelaços. A única tarifa descontada do saldo é a de saque."** That sentence answers theme 2, the most common gift objection, and part of theme 6 ("Pix direto não perde nada"). The home page only says "taxas e parcelas aparecem antes do pagamento", which every persona read as a hidden fee.

## Ranked fixes

Rank = weighted share × how directly it blocks "chamar no WhatsApp".

| # | fix | where | themes | kind |
| --- | --- | --- | --- | --- |
| 1 | Put "Vocês recebem 100% do valor de cada presente; as taxas ficam com o convidado e aparecem antes de ele pagar" in the gifts section, with one worked example in reais and the withdrawal fee | landing, gifts | 2, 6 | copy (cheap) |
| 2 | State what R$ 300 includes (site, painel, RSVP, mural, lista), that it is a one-time payment if true, how long the site stays online, and what typically costs extra | landing, process + FAQ | 3 | copy + commercial decision |
| 3 | Give a delivery window ("site pronto em até X dias depois do material") | landing, process | 4 | commercial decision |
| 4 | Show who is behind it: a name and face, CNPJ in the footer, an "about" line | landing, footer/closing | 1 | copy + business |
| 5 | Get the first real weddings live and ask for testimonials (offer a discount in exchange for a public case) | product/sales | 1, 8 | product decision |
| 6 | Reword "verificação de identidade" as a reason ("para o dinheiro cair só na conta de vocês") | landing, gifts | 5 | copy (cheap) |
| 7 | Show the guest's side: a short sequence of the phone screen with link → PIN → confirm, and the gift list as a guest sees it; say the PIN goes inside the invitation message and event info needs no PIN | landing, guests | 7 | design |
| 8 | Add a one-line comparison with free platforms ("vocês não montam nada; nós montamos e cuidamos") | landing, hero or models | 6 | copy |
| 9 | Decide on a premium/custom tier with its own price range, and a short line for assessoras (partnership, access) | product/commercial | 8, isolated | product decision |

Fixes 1 and 6 are copy changes that use facts already published on `/duvidas`. Fixes 2, 3 and 9 need commercial decisions before copy can change. Fixes 4 and 5 are the only ones that move trust substantially, and 5 is a business milestone, not a page edit.

## Flags

- **Positivity suspect:** not raised (buyer intent top-2 40%, non-buyer intent 2.75 and limited to "forward to my sister").
- **Low variance (partial):** every persona raised themes 1–3. This is plausibly real, since the page has no social proof and no fee number, but it is also where an LLM panel converges easily. Treat their *ranking* as signal and the 100% shares as an upper bound.
- **Thin audience file:** version 1 rests on assumptions (no analytics, no customer messages). Segment weights, especially S2 and S4, would change the overall numbers.

## Dropped and rerun responses

- P08 first run marked `contaminated` (used the designer term "hero"); rerun once with the same brief and kept. First run kept at the scratchpad `round1/contaminated/`.
- No responses dropped.

## Next

- Implement fixes 1 and 6 (copy only), recapture, and rerun the same tier and personas (P01–P10, audience v1) to measure the trust and comprehension delta. A gain under 0.3 is noise.
- Validate theme 1 and fix 2 with five real couples (show the page, ask the six questions) and by reading the first WhatsApp conversations: what is the first question people ask?

## Round 2 · 2026-11-27 (after the landing changes)

Same tier, personas (P01–P10), question, rater model and audience version 1. The piece is the local build of branch `docs/audience-panel`: hero with price and delivery window, rewritten gifts section ("100% do valor", Pix/card availability, withdrawal fee, verification reworded), new "Do primeiro contato à publicação" section with Site Modelo (R$ 300) and Site Exclusivo (a partir de R$ 500) and five steps, data question in the FAQ, CNPJ in the footer and a `/privacidade` page. Capture: 14 phone screenshots with a 700 px step (round 1 used 780 px, which hid a few lines under the sticky header; the change only closes gaps). No cookie notice in the local build. Raw material: [`2026-11-27-landing-mobile-standard-r2/`](./2026-11-27-landing-mobile-standard-r2/).

| construct | round 1 | round 2 | delta | top-2 r1 → r2 | S1 | S2 | S3 | S4 | S5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| comprehension | 3.31 | 3.33 | +0.03 | 38% → 40% | 3.42 → 3.37 | 3.35 → 3.45 | 3.10 → 3.12 | 3.40 → 3.40 | 3.20 → 3.32 |
| relevance | 3.73 | 3.87 | +0.14 | 65% → 70% | 4.42 → 4.45 | 3.48 → 3.95 | 3.70 → 3.85 | 3.45 → 3.45 | 2.70 → 2.70 |
| trust | 2.43 | 2.65 | +0.23 | 4% → 8% | 2.57 → 2.78 | 2.30 → 2.38 | 2.42 → 2.80 | 2.75 → 2.55 | 2.05 → 2.60 |
| **intent** | 3.07 | **3.44** | **+0.38** | 34% → 54% | 3.43 → 3.83 | 2.90 → 2.80 | 3.00 → 3.77 | 2.75 → 3.45 | 2.75 → 2.95 |

Reading: intent moved beyond the 0.3 noise threshold, driven by the core buyers (S1 +0.40, S3 +0.77) and the assessora. Trust improved but stays under the threshold and under 3 everywhere. Premium buyers (S2) did not move. Sentinel: non-buyer intent rose +0.20 (P05 now would forward the link to his daughter; P10 fell), inside the noise band, so the round is kept.

Themes that disappeared: the unquantified gift fee (round 1: 100%), the missing delivery time (75%) and the fear around "verificação de identidade" (63%). Price is now praised by most personas ("o preço aparece de cara").

Themes that remain or appeared:

1. **No real weddings or testimonials**: still everyone. Unchanged by design; it needs the first client.
2. **"Is it one person?"**: new, most personas. The footer with an individual's name and "desenvolvedor de software" answered "who is behind it" but raised "se ele sumir, quem dá suporte?" (P01, P02, P04, P05, P06, P07, P08, P09, P10).
3. **What R$ 300 covers over time**: most personas ask whether it is one-time or monthly, how long the site stays online after the wedding, "até o fim do contrato: que contrato?", domain and hosting (P01, P02, P03, P05, P06, P07, P09, P10).
4. **Fees still felt**: the guest paying R$ 103,69 and the R$ 3,67 withdrawal fee read as "always a fee" for price-sensitive personas (P03, P05, P07, P09, P10), though nobody calls them hidden anymore.
5. **Too much text on a phone** (P03, P05, P06, P07, P09), mostly in the gifts section.
6. **Isolated:** who writes the texts and how much work the material is (P02, P07); data export (P06); lodging/map section (P07); assessora terms and automatic reminders (P04); "is the card installment interest-free for the guest?" (P09); why guests would open a site instead of asking on WhatsApp (P10).

Next fixes, by impact: state "pagamento único" and how long the site stays online next to the price (needs the commercial answer); explain support continuity in one sentence (who answers, in what time); shorten the gifts copy; once the first client launches, add the real showcase.
