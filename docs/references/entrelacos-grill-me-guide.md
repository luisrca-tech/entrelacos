# EntreLaços — guia de passagem para `grill-me`

## Finalidade deste documento

Este documento consolida as decisões tomadas para o EntreLaços e prepara a próxima conversa de descoberta. Ele não é o PRD, a especificação técnica nem uma autorização para iniciar a implementação.

Direção visual e referências modernas estão registradas separadamente em [`entrelacos-design-references.md`](./entrelacos-design-references.md).

O próximo agente deve usar este material como estado inicial, questionar apenas decisões ainda abertas e separar rigorosamente:

1. decisões de produto e negócio;
2. decisões de arquitetura e engenharia;
3. planejamento de implementação.

## Estado atual

A direção do produto, a arquitetura de alto nível e a stack estão fechadas o suficiente para iniciar o `grill-me`. O produto completo ainda não está fechado: existem regras operacionais, detalhes de experiência, segurança, privacidade e escopo comercial que devem ser resolvidos antes da criação do PRD.

Nenhum código deve ser criado durante o `grill-me`. Quando a entrevista terminar, o agente deve declarar isso explicitamente, apresentar decisões confirmadas, itens deliberadamente adiados e riscos restantes. A implementação só começa após uma autorização separada.

## Identidade

- Nome de trabalho e identidade visual: **EntreLaços**.
- Nome técnico sem acento: `entrelacos`.
- Uso inicial: painel administrativo, login, favicon, exportações e materiais internos.
- O EntreLaços não terá domínio próprio nesta fase.
- O nome não será usado para criar subdomínios comerciais dos clientes.
- A escolha passou apenas por uma triagem informal de mercado. Uma busca de marca no INPI será necessária antes de divulgação comercial relevante ou investimento definitivo na marca.
- Frase de apoio candidata, ainda não obrigatória: “Tudo do casamento, no mesmo laço.”

## Visão do produto

O EntreLaços será uma operação brasileira de sites de casamento personalizados. Cada casamento recebe um site visualmente próprio, publicado e mantido pelo operador. As funcionalidades centrais serão padronizadas; alterações específicas poderão ser contratadas separadamente.

Não é objetivo inicial construir um SaaS de autosserviço nem um CMS. O operador continua responsável por criar o site, implementar sua identidade visual, publicar conteúdo e imagens, fazer deploy e prestar manutenção durante a vigência.

O casal ou a equipe de cerimonial terá acesso ao painel somente para administrar dados operacionais do casamento, especialmente convidados, RSVP e recados.

## Pacotes comerciais definidos

### Site comum

- Site personalizado.
- Endereço gratuito fornecido pela infraestrutura, por exemplo `ana-e-pedro-wedding.<conta>.workers.dev`.
- Cadastro e validação de convidados.
- RSVP.
- Recados.
- Painel administrativo.
- Sem domínio personalizado.
- Sem lista de presentes integrada.

### Site com domínio personalizado

Inclui tudo do site comum, além da compra e configuração do domínio e DNS como serviço adicional. Preço, responsabilidade de renovação e política para domínios já pertencentes ao cliente ainda precisam ser definidos.

### Site completo — futuro

Seria o site com domínio personalizado e lista de presentes. Este pacote pode não existir no lançamento. A lista de presentes e qualquer checkout continuam deliberadamente fora do MVP até uma decisão específica.

## Atores e permissões

### `OWNER`

- Usuário global do operador.
- Acessa todos os sites e todos os dados administrativos.
- Cria o acesso administrativo de cada casamento.
- Pode corrigir ou remover qualquer dado permitido pelo sistema.
- Não existe cadastro público de `OWNER`.

### `SITE_ADMIN`

- Usuário administrativo limitado a um casamento.
- É criado pelo operador, inicialmente por script ou comando interno.
- Pode ser utilizado pela noiva, pelo casal ou pela cerimonial, conforme combinado com o cliente.
- Na primeira versão, o mesmo acesso pode ser compartilhado entre noiva e cerimonial. O `grill-me` deve avaliar conscientemente o risco operacional dessa escolha, sem substituí-la silenciosamente por contas individuais.
- Não existe cadastro público, convite automático ou onboarding de clientes.

### Convidado

- Não cria conta e não possui login tradicional.
- Acessa o site público compartilhado do casamento.
- O contato principal valida sua identidade com nome completo, telefone cadastrado e código temporário enviado por SMS.
- Pode usar as funcionalidades liberadas para convidados daquele casamento.
- Não pode criar convidados, adicionar acompanhantes, remover membros ou alterar a composição do grupo.

## Modelo de convidados

- O agrupamento familiar é a unidade de organização e autorização.
- O nome visível do grupo, como “Família Rocha”, é opcional. Isso permite representar convidados individuais sem rótulo artificial de família.
- Cada grupo contém um ou mais integrantes.
- A quantidade de pessoas é derivada da lista de integrantes; não deve existir como número editável independente.
- Cada integrante possui inicialmente apenas nome completo e estado de RSVP.
- Cada grupo possui um contato principal e um único telefone de contato.
- Somente o contato principal realiza a confirmação e responde pelos integrantes do grupo.
- A noiva ou cerimonial cadastra grupos e integrantes manualmente no painel.
- Importação por CSV ou Word não faz parte do fluxo principal atual. Pode ser avaliada futuramente como ferramenta administrativa adicional.

## Acesso do convidado

- Não haverá link secreto por família.
- Todos recebem o endereço público do casamento.
- Para realizar ações protegidas, o contato principal informa nome completo e telefone.
- Se os dados corresponderem ao cadastro, o sistema envia um código temporário por SMS para o telefone registrado.
- Depois da validação, o sistema cria uma sessão familiar naquele dispositivo.
- Se a combinação não existir, a interface deve orientar a pessoa a contatar quem enviou o convite — normalmente noiva ou cerimonial.
- O nome e o telefone localizam o grupo; o código temporário comprova posse do telefone.
- Nome não é segredo. A autorização real não pode depender somente dele.
- A validação e a autorização devem ocorrer na API, nunca somente no navegador.

O MVP usará SMS com Twilio Verify. WhatsApp e fallback automático por outro canal ficam fora do MVP. Ainda precisam ser definidos pelo `grill-me`: normalização do nome e telefone, duração da sessão, tentativas inválidas, intervalo de reenvio, bloqueio temporário e uso de Turnstile.

## RSVP

- Estados iniciais: `PENDING`, `CONFIRMED` e `DECLINED`.
- O RSVP é individual, ligado ao integrante cadastrado, mas o contato principal responde por todos os integrantes do grupo.
- O convite cobre o casamento inteiro; não há subeventos ou convites diferentes para cerimônia e recepção.
- O contato principal pode alterar as respostas do grupo até o prazo configurado.
- Após o prazo, somente `SITE_ADMIN` ou `OWNER` pode registrar ou corrigir a resposta.
- O painel deve permitir consulta, filtros e exportação CSV.
- O contato principal não pode mudar a lista de integrantes do grupo.

## Recados

- O contato principal validado pode publicar um recado.
- O recado aparece automaticamente; não existe fila de aprovação.
- O nome exibido é o nome do contato principal validado, não digitado livremente.
- Isso comprova qual cadastro foi utilizado, mas não comprova fisicamente quem estava com o dispositivo.
- `SITE_ADMIN` e `OWNER` podem excluir um recado a qualquer momento.
- Não foi definida edição de recados pelo convidado.

Ainda precisam ser definidos: limite de tamanho, regras contra spam, conteúdo proibido, possibilidade de desativar recados por casamento e eventual registro mínimo de auditoria.

## Administração

O painel será uma aplicação central, e não uma página `/admin` incorporada a cada site público.

Funcionalidades previstas:

- autenticação de `OWNER` e `SITE_ADMIN`;
- seleção de casamento para o `OWNER`;
- isolamento automático do casamento para `SITE_ADMIN`;
- criação, edição e exclusão de grupos familiares;
- criação, edição e exclusão de integrantes;
- definição e correção do contato principal e do telefone familiar;
- consulta e alteração de RSVP;
- confirmação administrativa depois do prazo;
- filtros e exportação CSV;
- consulta e exclusão de recados;
- configuração da data limite do RSVP;
- consulta do estado e da vigência do site.

O painel não editará textos, imagens, vídeos, cores ou layout do site. Essas alterações permanecem no código e são executadas pelo operador.

## Exclusão e ciclo de vida

- `SITE_ADMIN` ou `OWNER` pode excluir um grupo familiar.
- A exclusão deve remover também integrantes, RSVP, recados e sessões vinculadas ao grupo.
- A interface deve pedir confirmação explícita antes da exclusão destrutiva.
- Cada site possui vigência de um ano contada a partir do lançamento.
- Ao final da vigência, o site é desabilitado.
- O domínio personalizado também costuma ser contratado por um ano, mas a vigência técnica do site e a renovação do domínio devem continuar modeladas como responsabilidades distintas.

Ainda precisam ser definidos: aviso prévio, renovação, período de tolerância, página mostrada depois da desativação, prazo de retenção, exportação final e exclusão definitiva dos dados.

## Conteúdo e mídia

- Textos, imagens, vídeos e identidade visual são gerenciados pelo operador no código.
- Não haverá upload por clientes ou convidados.
- Não haverá CMS nesta fase.
- Não haverá R2 ou outro armazenamento de objetos nesta fase.
- Arquivos versionados podem permanecer nos assets públicos de cada site.
- Se futuramente houver upload, biblioteca compartilhada ou alteração de mídia sem deploy, o armazenamento de objetos será reavaliado.

## Lista de presentes

Situação: **fora do MVP e sem decisão técnica**.

Não assumir:

- catálogo próprio;
- checkout;
- Pix dentro da plataforma;
- split de pagamento;
- webhook financeiro;
- intermediação de valores;
- exibição obrigatória de dados bancários;
- integração com loja ou lista externa específica.

O futuro `grill-me` dessa funcionalidade deve começar pela necessidade do casal e pelo modelo comercial. Somente depois deve comparar link externo, catálogo informativo, contribuição via Pix e checkout integrado. Checkout pode introduzir KYC, conciliação, estornos, chargebacks, tarifas, responsabilidades fiscais e obrigações adicionais de segurança e privacidade.

## Arquitetura de alto nível confirmada

### Monorepo

- Turborepo desde o início.
- Código, variáveis, comentários, documentação técnica e commits em inglês.
- A estrutura interna exata ainda não está congelada.

### Sites públicos

- Astro.
- Build estático.
- Um deploy independente por casamento.
- Cloudflare Workers Static Assets.
- Sem SSR e sem código de Worker quando não forem necessários.
- Endereço gratuito `*.workers.dev` na oferta base.
- Domínio personalizado como serviço adicional.
- Interações de RSVP, autenticação de convidado e recados chamam a API central pelo navegador.

A Cloudflare recomenda Workers Static Assets para novos projetos estáticos. Pages funcionaria, mas não será a escolha inicial. Referências:

- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/platform/limits/

O limite de Workers por conta deverá ser acompanhado porque a arquitetura prevê um Worker por casamento. Isso não bloqueia o MVP.

### Painel administrativo

- TanStack Start.
- Cloudflare Workers.
- Aplicação central multi-tenant.
- Pode usar inicialmente um endereço genérico `*.workers.dev`, sem domínio próprio.
- Atua como interface e, se necessário, BFF leve; não substitui a API central como autoridade das regras de negócio.

### API

- Hono.
- Node.js com TypeScript.
- Railway.
- Única autoridade sobre regras de negócio, autorização e isolamento entre casamentos.
- Único componente autorizado a acessar diretamente o banco na arquitetura inicial.

### Banco de dados

- PostgreSQL.
- Neon.
- Banco compartilhado e multi-tenant.
- Entidades de negócio isoladas por `siteId` ou identificador equivalente.
- O isolamento deve ser garantido na API e testado; filtros visuais do painel não constituem segurança.

### Modelo conceitual mínimo

O modelo final ainda será desenhado, mas deverá representar pelo menos:

- site/casamento e sua vigência;
- usuário administrativo;
- papel global `OWNER`;
- vínculo de `SITE_ADMIN` com site;
- grupo familiar;
- integrante/convidado;
- contato principal e telefone familiar;
- desafios e verificações temporárias, quando precisarem ser persistidos;
- estado e histórico mínimo de RSVP;
- recado ligado ao convidado autor;
- sessão administrativa;
- sessão ou credencial temporária do convidado, se adotada;
- domínio e estado de publicação, se necessário.

Não criar entidades de presentes ou pagamentos antes de essa funcionalidade ser aprovada.

## Princípios técnicos já estabelecidos

- O site público pode ser estático mesmo contendo formulários; os formulários chamam a API central.
- Toda autorização ocorre no backend.
- Senhas nunca ficam em texto puro no banco ou no código; códigos temporários devem ser delegados ao provedor de verificação sempre que possível.
- O `siteId` enviado pelo cliente não é suficiente para autorizar acesso administrativo.
- `SITE_ADMIN` nunca pode acessar dados de outro casamento.
- Conteúdo visual não será transformado em CMS por antecipação.
- Funcionalidades futuras não devem gerar abstrações ou tabelas especulativas no MVP.
- O frontend público não acessa o Neon diretamente.

## Separação dos artefatos

### 1. PRD de produto

Deve conter:

- problema e oportunidade;
- público-alvo e compradores;
- proposta de valor;
- modelo de serviço gerenciado;
- pacotes e limites comerciais;
- personas e responsabilidades;
- jornadas de administrador e convidado;
- regras de RSVP, convidados e recados;
- experiência de erros e exceções;
- ciclo de vida, renovação e encerramento;
- privacidade e políticas do produto;
- métricas de sucesso;
- escopo do MVP e não objetivos;
- critérios de aceite em linguagem de produto.

O PRD não deve escolher ORM, definir tabelas, descrever diretórios do monorepo ou conter comandos de deploy.

### 2. Especificação de arquitetura e engenharia

Criada somente depois da aprovação do PRD. Deve conter:

- contextos e limites dos sistemas;
- estrutura do Turborepo;
- modelo relacional e migrações;
- estratégia de autenticação e sessões;
- autorização e isolamento multi-tenant;
- contratos e versionamento da API;
- validação, erros, CORS e proteção contra abuso;
- deploy e provisionamento de novos sites;
- ambientes, secrets e configuração;
- observabilidade, auditoria e backups;
- estratégia de testes;
- automação do ciclo de vida;
- riscos, ADRs e decisões reversíveis ou irreversíveis.

A especificação técnica implementa o PRD; ela não pode alterar silenciosamente regras de produto.

### 3. Plano de implementação

Criado somente depois da aprovação da especificação técnica. Deve dividir o trabalho em fatias verticais verificáveis, com dependências, testes, critérios de conclusão e ordem de entrega. A existência do plano não autoriza implementação automaticamente.

## Árvore recomendada para o próximo `grill-me`

O agente deve perguntar uma questão por vez, sempre apresentar sua recomendação e fechar cada decisão explicitamente antes de seguir.

### Fase A — produto e negócio

1. Problema principal e proposta de valor.
2. Cliente comprador e usuário principal.
3. Limites do serviço gerenciado.
4. Escopo exato do pacote base.
5. Política de personalizações e revisões.
6. Preço, cobrança, cancelamento e renovação.
7. Jornada de contratação, coleta de conteúdo, lançamento e manutenção.
8. Responsabilidades do operador, casal e cerimonial.
9. Regras finais de convidados, RSVP e recados.
10. Ciclo de vida e destino dos dados.
11. LGPD, privacidade, termos e consentimentos necessários.
12. Métricas de sucesso e critérios de aceite do MVP.
13. Não objetivos e funcionalidades deliberadamente adiadas.

Ao encerrar essa fase, produzir e aprovar o PRD antes de discutir implementação detalhada.

### Fase B — arquitetura e engenharia

1. Limites entre site público, painel e API.
2. Estratégia de identificação do site em cada chamada pública.
3. Fluxo de nome + telefone + OTP por SMS e sessão familiar.
4. Autenticação administrativa e recuperação de acesso.
5. Modelo de autorização e isolamento multi-tenant.
6. Modelo de dados, exclusões e auditoria.
7. Contratos da API e tratamento de erros.
8. Proteção contra força bruta, spam e abuso.
9. CORS e lista de origens por casamento.
10. Escolha do ORM e estratégia de migrações.
11. Automação de criação, deploy, domínio e desativação de sites.
12. Ambientes, CI/CD e gerenciamento de secrets.
13. Logs, métricas, alertas, backups e recuperação.
14. Testes unitários, integração com PostgreSQL e fluxos ponta a ponta.
15. Limites de escala e estratégia para superar o limite de Workers.

### Fase C — planejamento

Somente depois das fases anteriores:

1. converter o PRD aprovado em especificação técnica;
2. registrar decisões arquiteturais importantes em ADRs;
3. dividir o MVP em fatias verticais;
4. definir critérios de qualidade e evidências;
5. pedir autorização explícita para implementar.

## Questões abertas prioritárias

Estas são as primeiras decisões que realmente bloqueiam o PRD:

1. Quem é o comprador inicial: casal, noiva, cerimonial ou combinação?
2. Qual problema é central: presença digital personalizada, organização de convidados ou os dois com o mesmo peso?
3. O que exatamente está incluído no preço do site comum e quantas revisões são permitidas?
4. Quais dados mínimos, além do nome e telefone familiar, podem ser coletados legitimamente?
5. O que acontece com site e dados ao completar um ano?
6. Como funcionam renovação, cancelamento e exportação final?
7. Quais canais e prazos de suporte fazem parte do serviço?

## Instrução pronta para a próxima conversa

Copie este documento para uma nova conversa e envie o seguinte pedido:

> Use a skill `grill-me` para aprofundar o produto EntreLaços descrito neste documento. Não escreva código, não crie repositório e não inicie implementação. Primeiro identifique contradições, lacunas e decisões que parecem confirmadas, mas ainda dependem de regras de produto. Depois conduza a entrevista fazendo exatamente uma pergunta por vez e incluindo sua resposta recomendada com os respectivos trade-offs. Resolva primeiro toda a Fase A. Quando ela terminar, declare explicitamente que o grill de produto acabou, apresente decisões confirmadas, itens adiados e riscos, e pergunte se está autorizado a gerar o PRD. Não misture o PRD com a especificação técnica. Só inicie a Fase B após o PRD de produto ser aprovado. Ao final da Fase B, encerre-a explicitamente e peça autorização separada antes de criar um plano ou implementar qualquer coisa.

## Critério para considerar o `grill-me` encerrado

O `grill-me` só termina quando:

- todas as decisões bloqueadoras da fase foram respondidas;
- contradições foram resolvidas;
- premissas restantes estão nomeadas;
- riscos e validações externas estão registrados;
- itens adiados estão explicitamente fora do escopo;
- o agente apresenta o resumo final;
- o usuário confirma o encerramento.

Uma resposta como “confirmado” fecha somente a decisão atual. Ela não autoriza criação de arquivos, repositório, código, deploy ou implementação.

## Suggested skills

- `grill-me`: obrigatório para conduzir a próxima entrevista, uma decisão por vez.
- `write-a-prd`: usar somente após encerrar e confirmar a Fase A.
- `orchestrate-plan` ou `prd-to-plan`: usar somente após PRD e especificação técnica aprovados.
- `ponytail`: usar na Fase B para evitar abstrações, integrações e dependências especulativas.
- `graphify`: usar quando existir um repositório e a análise estrutural do código começar; não é necessário para esta etapa de produto.

## Resumo executivo

O EntreLaços tem nome, proposta inicial, modelo gerenciado, pacotes-base e stack definidos. Sites públicos serão Astro estático em Cloudflare Workers Static Assets; o painel será TanStack Start em Cloudflare Workers; a API será Hono com Node.js no Railway; o banco será PostgreSQL no Neon; tudo ficará em Turborepo. O MVP cobre convidados, autenticação do contato familiar com OTP por SMS via Twilio Verify, RSVP, recados e administração. WhatsApp fica fora do MVP. Domínio personalizado é adicional. Presentes, checkout, CMS, uploads e R2 ficam fora do MVP. O próximo trabalho é fechar regras de produto, produzir o PRD e somente depois aprofundar a especificação técnica.
