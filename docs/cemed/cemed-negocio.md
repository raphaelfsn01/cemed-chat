# Spec de negócio — CEMED Saúde

O que a clínica faz, para quem, e por qual porta o pedido entra. É a camada de negócio
que o agente de triagem serve; a spec do agente vive em
[`agente-triagem-funcional.md`](agente-triagem-funcional.md).

**Fonte e data.** Site oficial `cemedsaude.com.br` e perfil `@saudecemed`, coletados em
**2026-08-24**. O site é uma SPA React — o conteúdo foi extraído do bundle JS, o que
significa que corresponde ao build publicado naquela data, não necessariamente ao que a
clínica pratica hoje. Tudo que **não** está publicado está na seção
[Lacunas](#8-lacunas--não-publicado). Nada aqui foi confirmado com a clínica.

---

## 1. Identidade e contato

| | |
|---|---|
| Razão de marca | CEMED Saúde — "Clínica Médica e Medicina do Trabalho" |
| Endereço | Rua Mayer, 152 — Centro, Rio das Ostras/RJ — CEP 28890-000 |
| Telefone / WhatsApp | (22) 99946-6060 — `wa.me/5522999466060` |
| Site | `cemedsaude.com.br` |
| Instagram | `@saudecemed` |
| Agregador de links | `linklist.bio/cemed` |

**Horário de atendimento**

| Dia | Horário |
|---|---|
| Segunda a sexta | 08h às 17h |
| Sábado | Fechado |
| Domingo | Fechado |

O `schema.org` do site declara `MedicalClinic` com `openingHoursSpecification` de
08:00–17:00 de segunda a sexta, coerente com a tabela exibida.

**Consequência operacional para a triagem:** todo lead que chega fora dessa janela — e
WhatsApp de clínica recebe muita mensagem à noite e no fim de semana — encontra a
clínica fechada. O agente tria normalmente (não tem horário próprio), mas a atendente só
assume no próximo dia útil. Ver §9 da spec funcional.

### Cobertura geográfica

**Unidade única, em Rio das Ostras. Não há unidade em Macaé.** Confirmado pela clínica
em 2026-08-24; coerente com o site, que cita exclusivamente Rio das Ostras e não traz
endereço nem telefone em Macaé.

Isso torna incorretas duas afirmações no projeto do agente:

- `config/setores.yml` declara `cliente.regiao: "Rio das Ostras / Macaé - RJ"`
- `app/prompts.py` afirma ao modelo, **hardcoded**, que a CEMED é "clínica em Rio das
  Ostras e Macaé (RJ)"

A primeira é inócua (o bloco `cliente:` nunca é lido pelo código). A segunda chega ao
modelo em toda classificação. Ver §9 item 3.

---

## 2. Convênios e formas de atendimento

O site anuncia **"3 convênios + particular"**:

- BRASEG
- Cartão da Família
- PAF SERRA-MAR
- Particular

Não há informação pública sobre quais serviços cada convênio cobre, se há
coparticipação, ou como funciona a autorização prévia.

**Consequência para a triagem:** menção a convênio é um dos sinais que o
`config/setores.yml` usa para distinguir **exames** (paciente) de
**medicina-ocupacional** (empresa) — "menciona convênio ou plano de saúde" aparece nas
descrições de `consultas` e `exames`. O agente não valida se o convênio citado é aceito;
isso é conversa da atendente.

---

## 3. Medicina do Trabalho — o pedido parte da empresa

Serviços de SST contratados por pessoa jurídica. É o bloco com maior volume de
documentação e o único que tem porta de entrada estruturada (§7).

### 3.1 Programas e documentos

| Sigla | Nome | Base legal | Entregáveis anunciados |
|---|---|---|---|
| **PCMSO** | Programa de Controle Médico de Saúde Ocupacional | NR-7 | Exames admissionais e demissionais; exames periódicos; exames de retorno e mudança de função; relatório anual |
| **PGR** | Programa de Gerenciamento de Riscos | NR-1 | Inventário de riscos; plano de ação; medidas de prevenção; acompanhamento contínuo |
| **LTCAT** | Laudo Técnico das Condições Ambientais do Trabalho | Previdenciário | Análise de agentes nocivos; classificação de atividades; aposentadoria especial; conformidade legal |
| **PPP** | Perfil Profissiográfico Previdenciário | INSS | Alinhado com PCMSO/PGR/LTCAT; pronto para envio ao eSocial; comprovação de tempo de exposição; base para aposentadoria especial |
| **eSocial SST** | Gestão de eventos SST | eSocial | S-2210 (CAT); S-2220 (ASO); S-2240 (condições ambientais) |

### 3.2 Modalidades de ASO

| Modalidade | Quando |
|---|---|
| Admissional | Antes do início do trabalho |
| Demissional | Antes do desligamento do colaborador |
| Periódico | Renovação anual ou conforme NR-7 |
| Retorno ao Trabalho | Após afastamento por doença ou acidente |
| Mudança de Função | Quando o risco ocupacional muda |

### 3.3 Exames complementares ocupacionais

Acuidade Visual · Audiometria · Eletrocardiograma (ECG) · Espirometria ·
Eletroencefalograma (EEG)

⚠️ **ECG, Espirometria e EEG aparecem também em §5 (exames diagnósticos).** O nome do
exame não determina o setor — quem está pedindo determina. Esta é a ambiguidade central
do domínio e a razão de existir a regra de desambiguação do agente. Ver §6 da spec
funcional.

### 3.4 Posicionamento

Diferenciais anunciados: agilidade no agendamento e nos resultados; conformidade com as
NRs; equipe dedicada a empresas; documentação completa (laudos, ASOs, relatórios). O
Instagram menciona atendimento in-company ("vai até a empresa para atender equipes") —
não confirmado no site.

---

## 4. Especialidades — consultas, o pedido parte do paciente

| Especialidade | Escopo anunciado |
|---|---|
| Clínico Geral | Avaliação completa da saúde, diagnósticos e orientações preventivas |
| Cardiologia | Consultas, exames e acompanhamento cardíaco |
| Neurologia | Diagnóstico e tratamento de doenças do sistema nervoso |
| Psiquiatria | Saúde mental com acompanhamento humanizado |
| Psicologia | Acompanhamento psicológico |
| Urologia | Saúde do sistema urinário masculino e feminino |
| Geriatria | Saúde e qualidade de vida do idoso |
| Nutrição | Orientação nutricional personalizada |

O `medicalSpecialty` do `schema.org` confirma: `PrimaryCare`, `Cardiovascular`,
`Neurologic`, `Psychiatric`, `Urologic`, `Geriatric`, `DietNutrition`.

---

## 5. Exames diagnósticos — o pedido parte do paciente ou do médico assistente

| Exame | Escopo |
|---|---|
| Eletrocardiograma (ECG) | Atividade elétrica do coração |
| MAPA 24h | Monitorização ambulatorial da pressão arterial por 24h |
| Holter 24h | Registro contínuo do ritmo cardíaco por 24h |
| Espirometria | Capacidade pulmonar e função respiratória |
| Eletroencefalograma (EEG) | Atividade elétrica cerebral |
| Polissonografia (tipo III e IV) | Estudo do sono: tipo III domiciliar, tipo IV em laboratório do sono |

O site afirma "exames feitos na própria clínica".

**Sobreposição com §3.3:** ECG, Espirometria e EEG. O discriminador é o contexto, nunca
o nome.

---

## 6. Espaço Integrar — terapias integrativas e reabilitação

Marca própria dentro da clínica.

| Terapia | Escopo anunciado |
|---|---|
| Quiropraxia | Ajustes articulares para dores de coluna, pescoço e articulações |
| Acupuntura | Agulhas em pontos estratégicos: dores, ansiedade, insônia |
| Fisioterapia | Reabilitação funcional, lesões, pós-operatório |
| Auriculoterapia | Estimulação auricular: ansiedade, tabagismo, dores, distúrbios emocionais |
| Ventosaterapia | Ventosas: circulação, tensões musculares, relaxamento |
| Terapias Integrativas | Categoria guarda-chuva, abordagem holística |

O site menciona acessibilidade ("acessível para pessoas com mobilidade reduzida") e
ambiente climatizado.

⚠️ **Auriculoterapia e ventosaterapia não são nomeadas no `config/setores.yml`**, que
lista apenas "quiropraxia, fisioterapia, acupuntura e demais terapias integrativas".
Ver §9.

---

## 7. Estética & Tricologia — Dra. Ana Prado

Único bloco com profissional nomeada publicamente. O site tem link de WhatsApp dedicado
com o texto "Gostaria de agendar com a Dra. Ana Prado."

**Procedimentos estéticos**
Aplicação de toxina botulínica · Harmonização facial · Bioestimulador de colágeno ·
Preenchimento facial · Preenchimento labial

**Tratamentos de pele**
Limpeza de pele · Tratamentos para acne · Clareamento de manchas · Melhora da qualidade
e textura da pele · Rejuvenescimento facial

**Tricologia**
Tratamentos para queda capilar e alopecia (calvície) · Protocolos para fortalecimento
dos fios · Avaliação e tratamento do couro cabeludo · Estímulo de crescimento capilar

⚠️ **Tricologia não aparece no `config/setores.yml`.** A descrição do setor `estetica` é
genérica ("interesse em aparência, procedimento estético facial ou corporal, pacotes de
sessões estéticas") e não menciona cabelo, queda capilar ou couro cabeludo. Ver §9.

---

## 8. Portas de entrada do lead

### 8.1 WhatsApp direto — a maioria do tráfego

Texto livre. Origem: número no Instagram, no Google, no linklist, ou indicação. É o
caminho para o qual o agente foi desenhado.

### 8.2 CTAs do site — WhatsApp com texto pré-preenchido

O site abre o WhatsApp com mensagem inicial já escrita, variando por página:

| Origem | Texto pré-preenchido |
|---|---|
| Geral / home | "Olá! Vim pelo site da CEMED Saúde e gostaria de mais informações." |
| Medicina do Trabalho | "…gostaria de informações sobre Medicina do Trabalho." |
| Espaço Integrar | "…gostaria de saber mais sobre o Espaço Integrar." |
| Estética | "Olá! Gostaria de agendar com a Dra. Ana Prado." |
| Agendamento | "…gostaria de agendar uma consulta." |

**Consequência para a triagem:** estes textos são sinal de setor quase determinístico e
chegam na primeira mensagem. Exceto o primeiro, que é genérico e provavelmente aciona
uma pergunta de desambiguação.

### 8.3 Guia de Encaminhamento — formulário estruturado ⚠️

A página `/medicina-do-trabalho` tem um formulário que, ao ser enviado, **abre o WhatsApp
com todo o conteúdo já montado**:

```
*Guia de Encaminhamento — CEMED Saúde*

Empresa: …
CNPJ: …
Responsável: …
Telefone: …
E-mail: …

Tipo de Exame: {Admissional | Demissional | Periódico | Mudança de Função | Retorno ao Trabalho}
Funcionário: …
Função: …
Obs: …
```

Campos obrigatórios: empresa, responsável, telefone, nome do funcionário. CNPJ, e-mail,
função e observações são opcionais.

**Duas consequências, ambas relevantes:**

1. **Triagem** — é o sinal mais forte de `medicina-ocupacional` que existe no sistema.
   O texto traz literalmente "Empresa", "CNPJ", "Funcionário" e o tipo de exame.
   Classificação com alta confiança e sem pergunta é o comportamento esperado.

2. **Privacidade** — o lead chega com **CNPJ, nome de funcionário, telefone e e-mail na
   primeira mensagem**. O README do projeto afirma que o agente "não coleta CPF, CNPJ,
   nome ou data de nascimento". Isso é verdade quanto a *pedir* e quanto a *persistir* —
   o schema fechado do classificador não tem campo para nada disso. Mas o agente
   **recebe** esses dados e os **transmite ao OpenRouter** junto com o resto da mensagem.
   Ver §7 da spec funcional.

### 8.4 Telefone

Todas as páginas oferecem `tel:+5522999466060` como alternativa. Fora do escopo do
agente.

---

## 9. Divergências entre este documento e `config/setores.yml`

O `config/setores.yml` alimenta o system prompt do classificador
(`app/prompts.py:montar_system_prompt`). Cada divergência abaixo é uma diferença entre o
que a clínica publica e o que o modelo sabe.

**Nenhuma foi corrigida.** Decisão consciente: spec documenta, não altera produção. Toda
mudança no YAML muda o prompt e exige rodar `testes/avaliacao_classificacao.py` antes de
ir ao ar.

| # | Item | `setores.yml` | Site | Impacto provável |
|---|---|---|---|---|
| 1 | **Tricologia** | ausente | bloco inteiro sob Estética | Lead que escreve "tenho queda de cabelo, vocês tratam?" não encontra sinal em nenhuma descrição de setor. Risco: pergunta desnecessária, ou — pior — classificação como `fora-de-escopo`, que **encerra a conversa**. |
| 2 | **Auriculoterapia / Ventosaterapia** | cobertas só por "demais terapias integrativas" | nomeadas | Menor. O guarda-chuva provavelmente segura, mas nomear é mais seguro que confiar na generalização do modelo. |
| 3 | **Macaé** — | `cliente.regiao: "Rio das Ostras / Macaé - RJ"`; **`app/prompts.py` diz ao modelo "clínica em Rio das Ostras e Macaé (RJ)"** | só Rio das Ostras | **Erro confirmado** pela clínica: não há unidade em Macaé. O modelo é informado do contrário em toda classificação. Lead que peça atendimento em Macaé tende a ser tratado como em-escopo e entregue à atendente, em vez de receber a informação correta. Ver §9.1. |
| 4 | **Convênios** | não mencionados | BRASEG, Cartão da Família, PAF SERRA-MAR | Baixo — o agente não valida convênio, só usa a menção como sinal de "não é ocupacional". Nomear os três poderia reforçar o sinal. |
| 5 | **Horário** | não mencionado | seg–sex 08–17, fechado fim de semana | Nenhum no roteamento. Relevante para expectativa de resposta (§9 da spec funcional). |
| 6 | **Guia de Encaminhamento** | não previsto | formulário estruturado | Ver §8.3. |

### 9.1 Por que o erro de Macaé escapou

Vale registrar, porque a causa é estrutural e vai se repetir.

O `app/prompts.py` tem uma regra explícita na própria docstring:

> O prompt é MONTADO a partir do `config/setores.yml`, não escrito à mão. As descrições
> de setor e a regra de desambiguação vivem no YAML, que é o único arquivo que muda entre
> clientes; **se o prompt as repetisse, sairiam de sincronia no primeiro cliente novo.**

A região é exatamente um dado que muda entre clientes — e é o único que ficou **fora**
dessa regra, escrito à mão na primeira linha do prompt. O `cliente.regiao` existe no
YAML, no lugar certo, e **nunca é lido**: `app/config.py:carregar` monta a
`Configuracao` a partir de `setores`, `operacao`, `mensagens_globais` e `desambiguacao`.
O bloco `cliente:` inteiro (`nome` e `regiao`) é decorativo.

Ou seja: o campo certo existe, está preenchido, e o valor que chega ao modelo vem de
outro lugar. Corrigir só o YAML **não** corrigiria o comportamento — é o tipo de conserto
que parece funcionar e não muda nada.

Correção sugerida (não aplicada — ver §12.2 da spec funcional):

1. `app/config.py` passa a ler `cliente.nome` e `cliente.regiao`
2. `app/prompts.py` interpola os dois em vez de hardcodar
3. `config/setores.yml` — `regiao: "Rio das Ostras - RJ"`
4. Rodar `testes/avaliacao_classificacao.py`

Isso fecha a classe inteira do problema, não só a instância.

---

## 10. Lacunas — não publicado

Nada abaixo aparece no site ou no Instagram. Precisa vir da clínica.

- **Preços** de qualquer serviço. (Por design, o agente nunca informa preço — vem de
  canned response editada pela clínica.)
- **Prazo de entrega** de PCMSO, PGR, LTCAT, PPP e eventos eSocial.
- **Demais profissionais** — só a Dra. Ana Prado é nomeada.
- **Regras de convênio** — cobertura por serviço, autorização prévia, coparticipação.
- **Política de encaixe e urgência.**
- **Capacidade diária** por setor — quantos ASOs, consultas e exames por dia.
- **Atendimento in-company** — mencionado no Instagram, não no site.
- **Tempo de resposta esperado** no WhatsApp durante o horário comercial.
