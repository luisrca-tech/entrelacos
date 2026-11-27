# Audience — Entrelaços · entrelacos
Version 1 · 2026-11-26 · Sources: `plans/entrelacos-prd.md` (buyer, managed-service model, packages), live landing `https://entrelacosbr.site/` (positioning, "a partir de R$ 300", WhatsApp-only contact), `apps/landing/README.md` (Meta Pixel/GA4 and Instagram/Facebook UTM plan → paid social is the planned channel), `apps/landing/src/faqContent.ts` (cash gift list via Pagar.me, guest pays fees, withdrawal fee). No analytics, customer messages or interviews were available; segment weights and demographics are assumptions grounded in the general Brazilian wedding market.
Locale: pt-BR · Default exposure: phone (390×844), opened from an Instagram/Facebook ad or a profile link, usually at night or in a break.

## Segments
| id | segment | weight | JTBD | entry channel | alternative today | confidence |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | Noivos classe média organizando sozinhos (casamento de 80–180 convidados) | 0.35 | Ter um lugar só para informações, RSVP e lista de presentes sem virar trabalho extra | Anúncio no Instagram, indicação de amiga | Site grátis de plataforma de lista (iCasei, Casar.com, Lejour), Canva + Google Forms + Pix no convite | mixed |
| S2 | Noivos com renda mais alta que valorizam estética e exclusividade | 0.20 | Um site bonito, "com a nossa cara", que impressione e que alguém faça por eles | Instagram (Reels, perfis de fornecedores), indicação da assessora | Site de plataforma de lista com template, ou designer/papelaria personalizada | assumption |
| S3 | Casamento pequeno ou civil, orçamento apertado | 0.20 | Avisar os convidados e receber ajuda em dinheiro gastando o mínimo | Anúncio no Instagram/Facebook | Grupo de WhatsApp, arte do Canva, chave Pix na mensagem, site grátis | mixed |
| S4 | Assessoras e cerimonialistas (time do evento) | 0.10 | Ferramenta confiável para RSVP e lista de convidados que possa indicar aos clientes | Instagram, busca, contato direto | Planilha Google, RSVP por telefone, plataforma que a noiva já escolheu | assumption |
| S5 | Não compradores: convidados curiosos, já casados, céticos de "site de casamento" | 0.15 | Nenhum (curiosidade, clique por engano, ou acha desnecessário) | Anúncio no feed | Nada; WhatsApp resolve | assumption |

## Assumptions to validate
- Who pays and decides is mostly the bride, with the partner opining — 5 short interviews with recent/near-wedding couples.
- The main alternative is a **free** wedding site from a gift-list platform, which makes "a partir de R$ 300" the core objection — ask 5 couples which site they used and what it cost; check WhatsApp conversations for the first price question.
- Paid social (Instagram) is the main channel and the visit happens on a phone — GA4 device/source report after the first campaign.
- Assessoras are a meaningful buyer/referrer channel (weight 0.10) — 3 conversations with local assessoras.
- Segment weights overall — compare `contact_whatsapp` events by campaign/audience once ads run.

## Personas

### P01 · Camila, 29 — noiva em Campinas, casamento em 9 meses e planilha aberta todo dia
- segment: S1 · confidence: mixed
- age*: 29 · gender: f · city: Campinas, SP
- income*: renda do casal R$ 9.800/mês; estão juntando para a festa, cada gasto extra é discutido
- life stage*: noiva, mora com o noivo há 2 anos, analista de RH CLT
- device & exposure: iPhone 12, Wi-Fi de casa; vê um anúncio no Instagram às 22h, deitada, depois de passar uma hora no Pinterest de casamento
- trigger*: casamento em agosto do ano que vem, 140 convidados, precisa mandar o save the date em 2 meses
- current alternative: já olhou o iCasei, que é grátis e tem lista de presentes; pensa em usar
- wants: um lugar só para o convidado ver tudo e confirmar, e receber os presentes sem dor de cabeça
- fears & objections*: pagar por algo que tem de graça; taxa escondida nos presentes; tios que não sabem usar site
- digital literacy: alta — compra online, usa Notion para o casamento
- price sensitivity: média-alta — paga algumas centenas se entender por que é melhor que o grátis
- decides with: decide ela, conta pro noivo, que só pergunta "quanto custa?"
- voice: "Gente, o iCasei é de graça e já tem lista. Pra eu pagar alguma coisa tem que ser muito melhor, e eu tenho que convencer o Diego."

### P02 · Marina, 33 — advogada em BH, quer tudo com cara de revista
- segment: S2 · confidence: assumption
- age*: 33 · gender: f · city: Belo Horizonte, MG
- income*: renda do casal R$ 32.000/mês; o orçamento do casamento passa de R$ 150 mil
- life stage*: noiva, advogada sócia de escritório pequeno, sem tempo
- device & exposure: iPhone 15 Pro; vê o anúncio no Instagram no intervalo entre reuniões, no escritório
- trigger*: casamento em 7 meses numa fazenda, já fechou fotógrafo e assessora
- current alternative: a assessora sugeriu um site de plataforma de lista; ela acha os templates "com cara de genérico"
- wants: algo exclusivo, que combine com a papelaria, e que alguém faça por ela
- fears & objections*: ficar parecido com o de todo mundo; empresa pequena sumir depois de pagar; não ter tempo de mandar conteúdo
- digital literacy: alta
- price sensitivity: baixa — se for bonito, paga; desconfia de coisa barata demais
- decides with: ela e a assessora; o noivo aprova
- voice: "Não tenho tempo pra ficar escolhendo template e mandando texto. Quero alguém que faça, que fique lindo e que eu não precise cobrar."

### P03 · Jéssica, 26 — casamento no civil com almoço para 40 pessoas em Recife
- segment: S3 · confidence: mixed
- age*: 26 · gender: f · city: Recife, PE
- income*: renda do casal R$ 4.200/mês; tudo do casamento está saindo do 13º
- life stage*: noiva, atendente de loja, noivo motoboy de aplicativo
- device & exposure: Android Samsung A15, 4G; vê o anúncio no Facebook no ônibus voltando do trabalho
- trigger*: civil em 3 meses, quer pedir ajuda em dinheiro para os móveis
- current alternative: grupo de WhatsApp da família e chave Pix na arte do convite feita no Canva
- wants: avisar todo mundo e juntar dinheiro pra casa
- fears & objections*: gastar com bobagem; taxa no Pix; parecer "pidona"
- digital literacy: média — Pix, Shopee, Instagram; nunca contratou site
- price sensitivity: muito alta — R$ 250 é a parcela do sofá
- decides with: ela e a mãe
- voice: "Pra 40 pessoas eu mando no grupo da família e pronto. Pix eu já recebo direto, né? Cada real tá contado."

### P04 · Renata, 41 — assessora de casamentos em Curitiba
- segment: S4 · confidence: assumption
- age*: 41 · gender: f · city: Curitiba, PR
- income*: faturamento do negócio R$ 18.000/mês; renda pessoal R$ 10.000; vive de indicação
- life stage*: casada, dois filhos adolescentes, dona de assessoria com 2 auxiliares, faz ~25 casamentos por ano
- device & exposure: iPhone 13; vê o anúncio no Instagram à noite, respondendo clientes
- trigger*: cansou de cobrar RSVP por telefone na semana do casamento e de planilha desatualizada
- current alternative: planilha Google compartilhada e ligação para os convidados
- wants: lista de presença confiável na mão dela, sem depender da noiva atualizar
- fears & objections*: indicar algo que falhe e queimar o nome dela; convidado idoso travar no PIN; não ter condição para parceiro
- digital literacy: alta no que usa no trabalho
- price sensitivity: média — quem paga é a noiva; ela quer saber se tem parceria
- decides with: ela recomenda, a noiva contrata
- voice: "Toda semana de casamento é a mesma coisa: metade não confirmou e sou eu que ligo pra cada tia. Se não for simples pro convidado, sobra pra mim."

### P05 · Roberto, 52 — pai da noiva, clicou no anúncio por curiosidade
- segment: S5 · confidence: assumption
- age*: 52 · gender: m · city: Goiânia, GO
- income*: renda familiar R$ 14.000/mês; está pagando parte da festa da filha e acha tudo caro
- life stage*: casado, gerente comercial, filha casa em 10 meses
- device & exposure: Android Motorola, 4G; vê o anúncio no Facebook no sofá, depois do jornal
- trigger*: viu "site de casamento" e lembrou da filha; não é ele quem organiza
- current alternative: a filha já está "vendo essas coisas" com a assessora
- wants: não gastar com o que não precisa
- fears & objections*: golpe; presente em dinheiro com taxa; "pra que site se tem WhatsApp?"
- digital literacy: baixa-média — WhatsApp, banco no app, Facebook
- price sensitivity: alta para "supérfluo"
- decides with: não decide; no máximo encaminha pra filha
- voice: "No meu tempo era convite de papel e pronto. Hoje tudo é aplicativo, tudo é taxa."

### P06 · Lucas, 31 — noivo que ficou com a parte "de tecnologia" do casamento em Porto Alegre
- segment: S1 · confidence: mixed
- age*: 31 · gender: m · city: Porto Alegre, RS
- income*: renda do casal R$ 12.500/mês; financiam o apartamento e o casamento ao mesmo tempo
- life stage*: noivo, desenvolvedor júnior, noiva professora
- device & exposure: Android Pixel 7; vê o anúncio no Instagram no almoço
- trigger*: casamento em 5 meses, 110 convidados; a noiva pediu "um site igual ao da prima"
- current alternative: pensou em fazer ele mesmo num construtor de sites, ou usar Casar.com
- wants: algo pronto que funcione, com RSVP e lista, sem ele ter que programar fim de semana
- fears & objections*: lock-in; dados dos convidados; não saber o prazo nem o preço final antes de conversar
- digital literacy: muito alta
- price sensitivity: média — compara com o custo do tempo dele
- decides with: a noiva decide o visual, ele decide se vale
- voice: "Eu até faria um site, mas não quero passar fim de semana mexendo nisso. Se for pra pagar, quero saber o preço antes de ter que conversar com vendedor."

### P07 · Aline, 35 — segundo casamento, festa pequena e chique em Florianópolis
- segment: S1 · confidence: mixed
- age*: 35 · gender: f · city: Florianópolis, SC
- income*: renda do casal R$ 16.000/mês; preferem pagar por praticidade
- life stage*: divorciada, noiva de novo, enfermeira em plantões 12x36, um filho de 8 anos
- device & exposure: iPhone 11; vê o anúncio no Instagram de madrugada, no intervalo do plantão
- trigger*: casamento em 4 meses, 80 convidados, muitos parentes de fora que vão precisar de hotel e endereço
- current alternative: no primeiro casamento usou um site grátis com propaganda e achou feio
- wants: alguém resolver; informações claras de local, hospedagem e horário
- fears & objections*: prazo apertado; ter que ficar mandando coisa e cobrando o fornecedor
- digital literacy: média
- price sensitivity: média-baixa
- decides with: ela decide
- voice: "Eu não tenho tempo nem pra respirar com esses plantões. Meu casamento é em março e tá tudo atrasado."

### P08 · Thiago, 34 — empresário em São Paulo, quer o site para impressionar os convidados
- segment: S2 · confidence: assumption
- age*: 34 · gender: m · city: São Paulo, SP
- income*: renda do casal R$ 45.000/mês
- life stage*: noivo, dono de agência de marketing, noiva médica
- device & exposure: iPhone 15; vê o anúncio no Instagram Stories no Uber
- trigger*: casamento em 8 meses, 250 convidados, muitos clientes e colegas
- current alternative: pedir para um designer da própria agência fazer uma landing
- wants: algo com vídeo, movimento, que pareça produção de cinema
- fears & objections*: parecer template; empresa sem portfólio real; suporte lento no dia do casamento
- digital literacy: muito alta, olha com olho crítico de marketing
- price sensitivity: muito baixa
- decides with: ele e a noiva, que só quer não se preocupar
- voice: "Eu trabalho com marketing, sei quando é só vitrine. Quero ver coisa real rodando, case, gente que usou."

### P09 · Daiane, 24 — vai casar na igreja da cidade, interior da Bahia
- segment: S3 · confidence: mixed
- age*: 24 · gender: f · city: Vitória da Conquista, BA
- income*: renda do casal R$ 3.600/mês; os pais ajudam com a festa
- life stage*: noiva, técnica de enfermagem, mora com os pais até casar
- device & exposure: Android Xiaomi Redmi, plano pré-pago com pouca internet; vê o anúncio no Instagram à noite
- trigger*: casamento em 6 meses, 200 convidados (família grande), quer uma lista de presentes
- current alternative: lista de presentes em loja de departamento da cidade e convite impresso
- wants: lista de presentes que os parentes de longe consigam usar
- fears & objections*: parcelado com juros pro convidado; tia achar que é golpe; não conseguir pagar o site
- digital literacy: média-baixa
- price sensitivity: muito alta
- decides with: ela, o noivo e a mãe
- voice: "Minha família é enorme e metade mora longe. Se for coisa de internet, tem que ser fácil pra minha vó, senão ninguém usa."

### P10 · Fernanda, 38 — já casou, viu o anúncio e lembrou da trabalheira
- segment: S5 · confidence: assumption
- age*: 38 · gender: f · city: Rio de Janeiro, RJ
- income*: renda familiar R$ 11.000/mês
- life stage*: casada há 6 anos, uma filha, coordenadora administrativa
- device & exposure: Android Samsung S21; vê o anúncio no Instagram no metrô
- trigger*: nenhum casamento próprio; a irmã mais nova ficou noiva mês passado
- current alternative: na época usou um site grátis de lista de presentes
- wants: nada para si; talvez indicar pra irmã se for bom
- fears & objections*: acha que site de casamento ninguém abre; convidado só olha o endereço
- digital literacy: média-alta
- price sensitivity: alta para algo que acha dispensável
- decides with: não decide
- voice: "No meu ninguém entrou no site, só perguntavam o endereço no zap. Mandar pra minha irmã? Talvez, se for barato."

### P11 · Bruna, 27 — noiva de Fortaleza que planeja tudo pelo Instagram
- segment: S1 · confidence: mixed
- age*: 27 · gender: f · city: Fortaleza, CE
- income*: renda do casal R$ 7.000/mês
- life stage*: noiva, social media freelancer, noivo bancário
- device & exposure: iPhone XR; vê o anúncio no Instagram no fim da tarde, no café
- trigger*: casamento em 11 meses, 120 convidados, ainda não escolheu nada além do local
- current alternative: salvou vários perfis de convite digital animado (vídeo de R$ 80)
- wants: algo bonito pra postar e mandar no WhatsApp
- fears & objections*: pagar e o prazo atrasar; não conseguir mudar depois; lista em dinheiro parecer interesseira
- digital literacy: alta
- price sensitivity: média
- decides with: ela decide, consulta as amigas
- voice: "Amo coisa bonita, mas já vi muito convite digital que no celular fica tudo cortado. Tem que funcionar no zap das tias."

### P12 · Paulo, 45 — vai casar com a companheira de 15 anos, casamento comunitário vira festa
- segment: S3 · confidence: assumption
- age*: 45 · gender: m · city: Manaus, AM
- income*: renda familiar R$ 5.500/mês
- life stage*: vive em união estável, 3 filhos, mecânico autônomo
- device & exposure: Android Motorola G, 4G; vê o anúncio no Facebook no domingo à tarde
- trigger*: festa em 2 meses para formalizar a união, 70 convidados
- current alternative: convite pelo WhatsApp e cada um leva um prato
- wants: algo simples
- fears & objections*: golpe na internet; não entender como funciona; pagar e ser enganado
- digital literacy: baixa
- price sensitivity: muito alta
- decides with: a companheira
- voice: "Essas coisas de internet eu desconfio. Vou mostrar pra patroa, ela que entende."

### P13 · Juliana, 30 — assessora iniciante no Rio, monta o portfólio
- segment: S4 · confidence: assumption
- age*: 30 · gender: f · city: Niterói, RJ
- income*: renda pessoal R$ 5.000/mês, metade ainda vem de outro emprego
- life stage*: solteira, assessora há 2 anos, faz ~10 casamentos por ano
- device & exposure: Android Samsung A54; vê o anúncio no Instagram enquanto edita stories de clientes
- trigger*: quer oferecer algo a mais que as assessoras grandes não oferecem
- current alternative: indica o site grátis da plataforma de lista
- wants: um diferencial, comissão por indicação
- fears & objections*: o cliente achar caro e ela perder o contrato; não ter material pra mostrar
- digital literacy: alta
- price sensitivity: alta (por causa dos clientes)
- decides with: ela recomenda
- voice: "Eu preciso de algo que me diferencie das assessoras grandes. Se tiver parceria, eu ofereço em todo contrato."

### P14 · Rafael, 28 — noivo que estranha lista de presentes em dinheiro
- segment: S1 · confidence: mixed
- age*: 28 · gender: m · city: Ribeirão Preto, SP
- income*: renda do casal R$ 8.500/mês
- life stage*: noivo, engenheiro agrônomo trainee, noiva dentista recém-formada
- device & exposure: Android Samsung A34; vê o anúncio no Instagram à noite
- trigger*: casamento em 10 meses; a noiva quer lista em dinheiro, a família dele acha "feio"
- current alternative: lista em loja (Camicado, Tok&Stok)
- wants: algo que deixe a família à vontade e não pareça cobrança
- fears & objections*: taxa para o convidado; família desconfiar de pagar por site; ter que fazer cadastro com documento
- digital literacy: média-alta
- price sensitivity: média
- decides with: a noiva, mas ele tem veto
- voice: "Esse negócio de o convidado pagar a taxa... minha tia vai ver o valor maior e reclamar comigo no casamento."

### P15 · Carolina, 32 — noiva publicitária em Brasília, olho clínico pra design
- segment: S2 · confidence: assumption
- age*: 32 · gender: f · city: Brasília, DF
- income*: renda do casal R$ 24.000/mês
- life stage*: noiva, diretora de arte, noivo servidor público
- device & exposure: iPhone 14; vê o anúncio no Instagram no sábado de manhã
- trigger*: casamento em 12 meses, quer identidade visual própria em tudo
- current alternative: ela mesma desenhar no Figma e pedir pra um amigo dev subir
- wants: liberdade de personalizar fonte, cor e layout
- fears & objections*: só dois modelos; ficar preso ao "estilo da casa"
- digital literacy: muito alta
- price sensitivity: baixa
- decides with: ela
- voice: "Eu não quero template. Quero a minha identidade em tudo, da papelaria ao site. Se ficar com cara de modelo pronto, eu mesma faço."

### P16 · Sônia, 49 — mãe da noiva que organiza tudo pela filha em Salvador
- segment: S1 · confidence: assumption
- age*: 49 · gender: f · city: Salvador, BA
- income*: renda familiar R$ 10.000/mês; ela paga boa parte da festa
- life stage*: casada, servidora estadual, filha de 26 trabalha fora
- device & exposure: Android Samsung A54, fonte grande; vê o anúncio no Facebook à noite
- trigger*: festa da filha em 6 meses, 180 convidados, quer controlar quem confirmou
- current alternative: caderno e lista no WhatsApp
- wants: saber quem vem, mesa por família
- fears & objections*: não saber mexer; golpe; pagar sem ver ninguém
- digital literacy: baixa-média
- price sensitivity: média
- decides with: ela e a filha
- voice: "Eu anoto tudo no caderno, família por família, quem vem e quem não vem. Coisa de internet eu preciso que alguém me explique devagar."

### P17 · Gabriel, 36 — cerimonialista dono de buffet em Londrina
- segment: S4 · confidence: assumption
- age*: 36 · gender: m · city: Londrina, PR
- income*: faturamento do buffet R$ 60.000/mês
- life stage*: casado, dono de buffet e cerimonial com equipe de 12
- device & exposure: iPhone 13; vê o anúncio no Instagram no escritório
- trigger*: quer número de confirmados confiável para fechar a quantidade de comida
- current alternative: ligação da equipe para cada convidado na última semana
- wants: exportar lista de confirmados por família para a recepção
- fears & objections*: dados que não batem; ninguém atender quando der problema
- digital literacy: média
- price sensitivity: baixa se resolver
- decides with: ele, para oferecer no pacote do buffet
- voice: "Se esse painel me der a lista certinha uma semana antes, eu ponho no pacote. Exporta pra planilha?"

### P18 · Larissa, 23 — convidada curiosa que clicou no anúncio
- segment: S5 · confidence: assumption
- age*: 23 · gender: f · city: Belém, PA
- income*: renda pessoal R$ 2.300/mês, mora com os pais
- life stage*: solteira, estudante de enfermagem e estagiária
- device & exposure: Android Samsung A14; vê o anúncio no Instagram na fila do bandejão
- trigger*: nenhum; achou as alianças bonitas
- current alternative: nada
- wants: nada
- fears & objections*: nenhuma, só não é pra ela
- digital literacy: alta no celular
- price sensitivity: muito alta
- decides with: ninguém
- voice: "Casamento? Nem namorado eu tenho kkkk. Mas adoro ver essas coisas de noiva."

### P19 · Eduardo, 41 — cético que acha site de casamento desnecessário
- segment: S5 · confidence: assumption
- age*: 41 · gender: m · city: Joinville, SC
- income*: renda familiar R$ 13.000/mês
- life stage*: noivo pela primeira vez, gerente de produção, noiva quer site
- device & exposure: Android Motorola Edge; vê o anúncio no Instagram que a noiva mandou no WhatsApp dele
- trigger*: a noiva quer, ele acha gasto à toa
- current alternative: WhatsApp e convite impresso
- wants: gastar o mínimo
- fears & objections*: pagar por algo que convidado não usa; taxa nos presentes
- digital literacy: média
- price sensitivity: alta
- decides with: a noiva decide; ele resiste
- voice: "Pagar pra fazer uma página? Meu sobrinho faz isso de graça. Casamento já tá caro demais."

### P20 · Patrícia, 37 — noiva paulistana que já foi enganada por fornecedor
- segment: S2 · confidence: assumption
- age*: 37 · gender: f · city: Santos, SP
- income*: renda do casal R$ 20.000/mês
- life stage*: noiva, gerente de banco, casamento remarcado após fornecedor falir
- device & exposure: iPhone 14 Plus; vê o anúncio no Instagram à noite
- trigger*: casamento em 9 meses, precisa refazer convites e site
- current alternative: plataforma grande e conhecida, mesmo achando feia
- wants: segurança, contrato, empresa com CNPJ e rosto
- fears & objections*: empresa nova sumir; dinheiro dos presentes preso; nada sobre quem está por trás
- digital literacy: alta
- price sensitivity: média-baixa
- decides with: ela e o noivo
- voice: "Já levei calote de buffet. Agora só fecho com quem tem CNPJ, contrato e alguém que eu consiga ver a cara."
