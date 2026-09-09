# Spec funcional — Agente de Triagem WhatsApp CEMED

O que o agente faz, sob quais regras, e o que acontece quando algo falha. Público: quem
vai mexer no código. Cada regra aponta o módulo onde vive e, quando existe, o teste que
a trava.

O domínio que ele serve está em [`cemed-negocio.md`](cemed-negocio.md).

**Estado:** descreve o comportamento implementado em `app/` na data desta spec. Não é
proposta — é o contrato do que já existe.

> ⚠️ **Aviso adicionado em 2026-08-26:** a afirmação acima está incorreta para este
> repositório. Este documento descreve um protótipo anterior (Python, rodando em Docker,
> integrado ao Chatwoot via AgentBot) que **nunca foi implantado neste repositório** — o
> `cemed-chat` não tem Chatwoot nem código Python; o agente real é TypeScript sobre WAHA
> (`lib/agent-engine/`). As **regras de negócio de triagem** descritas abaixo continuam
> valendo como conhecimento acumulado (inclusive bugs já encontrados no protótipo), mas a
> descrição de arquitetura/infraestrutura (linha 17 em diante) não corresponde ao sistema
> atual. Para a arquitetura real, ver
> [`arquitetura-sistema.md`](arquitetura-sistema.md).

---

## 1. Propósito

Recepcionista de IA que tria as conversas do WhatsApp da clínica **antes** de entregá-las
às atendentes. Roda em container Docker na mesma rede do Chatwoot e integra-se a ele
apenas pela API pública, como AgentBot.

Três funções, em ordem de valor:

1. **Deflexão** — encerrar sozinho as conversas fora do escopo da clínica (~25-28/dia é
   o esperado). É o objetivo nº1: trabalho que a atendente deixa de fazer.
2. **Triagem** — decidir o setor e entregar ao humano com um resumo do pedido.
3. **Desambiguação** — quando não dá para saber o setor, **perguntar em vez de chutar**.

Volume de projeto: 125-140 conversas/dia.

### 1.1 A regra inviolável

> **O agente nunca conclui um atendimento.** Ele tria, etiqueta e entrega a um humano.

Exceção única: conversa fora do escopo da clínica, que ele responde educadamente,
etiqueta e encerra.

Isso não é convenção — é travado em três camadas:

| Camada | Onde | O quê |
|---|---|---|
| Configuração | `app/config.py:_ler_setores` | Recusa subir se ≠ 1 setor tiver `acao: "encerrar"` |
| Execução | `app/processador.py:_processar_sob_lock` | `resolved` só quando `setor.encerra_conversa` |
| Falha | `app/processador.py:_escalar` | Escalada por erro **nunca** encerra — sempre `open` |

A terceira é a mais sutil: encerrar por erro seria deflexão falsa, e perderia um cliente
real em silêncio.

---

## 2. Escopo

### 2.1 O que o agente faz

- Recebe `message_created` do AgentBot via webhook autenticado por HMAC
- Agrega mensagens em rajada numa janela de debounce
- Lê anexos (foto/PDF de guia ou pedido médico) para dar contexto ao classificador
- Classifica o setor via LLM com enum fechado
- Faz **uma** pergunta de desambiguação quando falta sinal
- Envia ao lead uma **canned response** cadastrada no Chatwoot
- Escreve nota privada para a atendente, monta em código
- Aplica label de setor e grava `custom_attributes` de triagem
- Move a conversa para `open` (entrega) ou `resolved` (fora de escopo)
- Devolve ao humano conversas travadas, via watchdog

### 2.2 O que o agente deliberadamente NÃO faz

Cada item aqui é decisão, não pendência.

| Não faz | Por quê |
|---|---|
| **Pedir CPF, CNPJ, nome ou data de nascimento** | Reduz drasticamente a superfície de dado pessoal do serviço. Código que peça documento ao lead é regressão — a suíte trava isso. |
| **Concluir atendimento** | §1.1 |
| **Prometer vaga, horário ou preço** | Confirmação é sempre manual. A nota privada diz isso explicitamente à atendente. |
| **Dar orientação médica** | O prompt manda acolher com uma frase, não interpretar, não sugerir diagnóstico nem conduta. É recepção, não profissional de saúde. |
| **Escrever texto livre ao lead** | Toda mensagem sai de canned response editada pela clínica na UI do Chatwoot. **Exceção única:** o campo `pergunta` da desambiguação, o único texto voltado ao lead que o modelo gera. |
| **Hardcodar preço, horário ou texto de atendimento** | A clínica edita pela UI, sem deploy e sem chamado. |
| **Falar por cima de um humano** | Se a conversa não está mais em `pending`, o agente aborta. |
| **Persistir conteúdo de anexo** | Vive só na memória do worker durante a chamada ao LLM. O original continua no Chatwoot, onde a atendente o vê. |
| **Manter série histórica** | `/metricas` zera no restart. Histórico é papel das labels no Chatwoot. |

---

## 3. Máquina de estados

Dois eixos independentes que precisam ser lidos juntos.

### 3.1 Status da conversa (Chatwoot)

```
pending  — bot no comando. é a ÚNICA condição em que o agente age.
open     — humano no comando. Bot silencia.
resolved — encerrada. Só o caminho de deflexão chega aqui.
```

`pending` significa "bot no comando" — `app/filtros.py`. Qualquer outro status
significa que um humano assumiu.

### 3.2 `triagem_status` (custom_attributes) — `app/modelos.py:StatusTriagem`

| Valor | Significado |
|---|---|
| `classificando` | Agente decidindo |
| `aguardando_resposta` | Agente **perguntou** e espera o lead. Janela de watchdog estendida (§8.2). |
| `entregue` | Já é do humano. Terminal do ponto de vista do agente. |

### 3.3 Transições

```
chega mensagem em conversa pending
  → [debounce ~3s]
  → classificação
  → três desfechos possíveis:

    1. precisa_perguntar
       → aguardando_resposta (status=pending, bot segue no comando)
         → lead responde → nova rodada de classificação
         → lead nunca responde → watchdog resgata em 2h

    2. setor decidido
       → acao=entregar → entregue, status=open, +label do setor
       → acao=encerrar → entregue, status=resolved, +label fora-de-escopo

    3. falha/erro
       → entregue, status=open, SEM label de setor
```

**Nota importante:** a rodada de desambiguação **não aplica label nenhuma**. Etiquetar
antes de decidir seria o roteamento errado registrado com aparência de certeza —
`app/processador.py:_perguntar`.

---

## 4. Pipeline de processamento

### 4.1 Handler do webhook — `app/main.py:webhook`

Faz **quatro** coisas e devolve 200 em milissegundos: valida assinatura, deduplica,
filtra, enfileira. Nada mais.

**Por que isso importa mais do que parece:** o timeout do webhook do Chatwoot é de
**5 segundos**. Se o serviço demorar, o Chatwoot move a conversa de `pending` para `open`
sozinho. Chamar o LLM dentro do handler faria **toda** conversa escalar para humano — e
o agente pareceria inerte sem nada quebrar visivelmente.

**Contrato de códigos de resposta.** Errar isto causa loop de retry:

| Código | Situação |
|---|---|
| `401` | Assinatura inválida, ausente ou fora da janela |
| `413` | Corpo acima de 1 MB |
| `200` | Aceito e enfileirado |
| `200` | Filtrado (outgoing, private, status ≠ pending) — descarte não é erro |
| `200` | Entrega duplicada |
| `200` | Payload inválido, incompleto, ou inbox fora da allowlist |

O handler **nunca devolve 500 por acidente**: o Chatwoot faz retry em 500 e o lead
receberia a mesma resposta várias vezes.

⚠️ **A docstring de `app/main.py:webhook` documenta um `429` para "fila cheia" que não
existe no código.** Não há fila com limite: `_agendar` cria uma task e retorna. Não há
backpressure — sob carga extrema o serviço acumula tasks até estourar memória, em vez de
devolver 429 e deixar o Chatwoot repetir. Para o volume de projeto (125-140/dia) isso
não é problema prático, mas a docstring descreve um mecanismo inexistente.

### 4.2 Verificação de assinatura — `app/assinatura.py`

```
assinatura = "sha256=" + HMAC-SHA256(secret, "{timestamp}.{corpo_bruto}")
```

Regras:

- Calculada sobre os **bytes brutos** (`await request.body()`), antes de qualquer parse.
  Se o corpo passar por Pydantic e for re-serializado, os bytes mudam e o digest nunca
  bate.
- Validação de forma (tamanho 64, só hexadecimal, timestamp só dígitos) **antes** da
  conta.
- `hmac.compare_digest` — não vaza informação por tempo de resposta.
- Janela nos **dois sentidos** (`abs(agora - ts) > janela`). Rejeitar só o passado
  deixaria um relógio adiantado do outro lado virar janela de replay aberta por horas.
- Nunca levanta. Retorna `False`, que o handler traduz em 401.

⚠️ **Bug conhecido do Chatwoot ([#13809](https://github.com/chatwoot/chatwoot/issues/13809)):**
a assinatura é gerada com um campo interno `hmac_token`, enquanto a API devolve um
`secret` diferente. Com o valor errado o serviço rejeita **100%** do tráfego, e o
sintoma é indistinguível de "o bot está desligado". `scripts/spike_webhook.py` existe
para descobrir qual segredo assina de fato.

Testes: `testes/teste_hmac.py`

### 4.3 Filtro — `app/filtros.py:deve_processar`

Processa **apenas** se as três condições valerem juntas:

```python
event          == "message_created"
message_type   == "incoming"      # não é o bot nem a atendente falando
private        is False           # explicitamente False, não apenas ausente
conversation.status == "pending"  # bot no comando
```

Duas decisões que merecem nota:

- **`private is False`, não `not private`.** Se o Chatwoot um dia omitir o campo, o
  serviço para de responder e o watchdog move as conversas para humano — degradação
  visível. A alternativa (tratar ausente como público) faria o bot responder a notas
  internas entre atendentes: falha pior, e silenciosa.
- **Funções puras, tolerantes a payload malformado.** Campo faltando significa "não
  processar", nunca exceção. Exceção aqui viraria 500, e o Chatwoot faz retry em 500.

Testes: `testes/teste_filtros.py`

### 4.4 Deduplicação — `app/dedup.py`

O Chatwoot faz retry em 429 e 500, até 3 tentativas. Sem dedup, a mesma mensagem chega
duas ou três vezes ao lead.

- Chave preferencial: header `X-Chatwoot-Delivery`. Fallback: `msg:{id_da_mensagem}`.
- Sem nenhum dos dois: **processa mesmo assim**, com log de aviso. Perder uma mensagem é
  pior que arriscar uma duplicata.
- Cache em memória com TTL. `ttl_dedup_segundos` **precisa** ser ≥
  `janela_assinatura_segundos`, senão uma entrega repetida dentro da janela é aceita de
  novo. `app/config.py:_ler_operacao` valida essa relação no boot.

⚠️ **Restrição de deploy:** o cache vive na memória do processo. Com dois workers cada um
tem o seu, a dedup deixa de funcionar em metade dos casos, e o lead recebe a mesma
resposta duas vezes. `docker-compose.yml` roda `uvicorn --workers 1` — **não aumente**.
Um worker assíncrono atende 125-140 conversas/dia com folga.

Testes: `testes/teste_dedup.py`

### 4.5 Allowlist de inbox — `app/main.py:webhook`

O `inbox.id` do payload é validado contra `inboxes_permitidas` do YAML. O `account.id` do
payload é **ignorado por completo** em favor de `CHATWOOT_ACCOUNT_ID` do `.env`. Nenhum
dos dois vem de fonte confiável, e não podem decidir sobre quem o serviço age.

Com `inboxes_permitidas: []` o serviço aceita qualquer inbox da conta e loga aviso no
boot. **Pendência antes de produção.**

### 4.6 Debounce — `app/processador.py:enfileirar`

Janela de ~3s por conversa (`debounce_segundos`). Ao final, processa **todas** as
mensagens acumuladas de uma vez.

**Por que existe:** no WhatsApp as pessoas mandam a foto da guia e depois "é pra
admissão" como mensagens separadas. Sem isso cada uma vira uma classificação e uma
resposta — e a desambiguação nunca funciona, porque o modelo nunca vê os dois sinais
juntos.

Mensagem nova **estende** a janela em vez de abrir outra: quem digita em rajada não é
interrompido no meio do raciocínio.

---

## 5. Processamento — `app/processador.py:_processar_sob_lock`

Roda em background, fora do ciclo da request. Sob **lock por conversa** de ponta a ponta
— não global. Lock global serializaria a clínica inteira: duas pessoas diferentes
escrevendo ao mesmo tempo esperariam uma pela outra.

Sequência:

**1. Re-checagem de status.** O filtro do handler olhou o payload, que reflete o estado
no momento do envio. Entre aquilo e agora passaram segundos — tempo de sobra para a
atendente abrir a conversa. Se não é mais `pending`, **aborta**.

Se a leitura do status **falha**, aborta também. Não dá para saber se o humano assumiu, e
falar por cima da atendente é pior do que o lead esperar um pouco — o watchdog pega a
conversa parada depois.

**2. Circuit breaker.** `max_mensagens_por_conversa: 12`. Atingido — escala para humano.
O filtro de `outgoing` é a única outra barreira contra loop de mensagens; se ele falhar,
isto impede a conversa de virar loop de custo.

**3. Download de anexos + classificação.** Anexo inacessível **degrada em vez de travar**:
classificar só com o texto é pior que com o anexo, mas muito melhor que deixar o lead
pendurado.

**4. Bifurcação.** `precisa_perguntar` — pergunta (§6.2). Senão — entrega ou deflexão.

**5. Ação.** Nesta ordem: envia canned response — nota privada — grava atributos —
aplica label — define status.

---

## 6. As funções de decisão

### 6.1 Classificação de setor — `app/classificador.py`

LLM via **OpenRouter** (API OpenAI-compatível), com **tool use forçado** e **enum
fechado**.

```python
tool_choice = {"type": "function", "function": {"name": "registrar_triagem"}}
```

Campos do schema — e **apenas** estes:

| Campo | Tipo | Papel |
|---|---|---|
| `setor` | enum fechado + `""` | `""` é o valor legítimo para "ainda não decidi" |
| `confianca` | number 0–1 | |
| `o_que_quer` | string | Poucas palavras. "NÃO transcreva documentos, CPF/CNPJ, nomes ou datas de nascimento." |
| `quando` | string | Preferência de data/horário como o lead expressou |
| `para_empresa` | boolean | **O discriminador** entre medicina-ocupacional e exames |
| `precisa_perguntar` | boolean | |
| `pergunta` | string | Único texto ao lead gerado pelo modelo |

`additionalProperties: False` e `strict: True`.

**Este schema é o mecanismo de privacidade do sistema.** Não há campo de documento —
e instruir "não extraia CPF" no prompt depende de o modelo obedecer; não oferecer o
campo não depende de nada. `_extrair` lê só os campos conhecidos de `Classificacao` e
descarta o resto.

**Degradação segura:** um modelo fraco que devolva setor fora do enum, ou que não use a
ferramenta, faz o processador **escalar para humano** — não rotear errado. O pior de um
modelo ruim aqui é qualidade de triagem, nunca vazamento nem ação indevida.

Parâmetros: `max_tokens=1024`, `timeout=20s`, texto do lead truncado em
`max_caracteres_mensagem: 4000`.

⚠️ **Ao trocar de modelo, dois requisitos são inegociáveis:** suportar `tool_choice`
forçado, e ser multimodal se for ler anexo. Todo modelo novo passa por
`testes/avaliacao_classificacao.py` antes de virar padrão. Padrão atual:
`anthropic/claude-haiku-4.5`.

### 6.2 Desambiguação — a regra que mais importa

**Fato do domínio:** ECG, Espirometria e EEG existem em **dois setores** —
`medicina-ocupacional` e `exames` (ver §3.3 e §5 da spec de negócio). **O nome do exame
não determina o encaminhamento.** O discriminador é quem está pedindo.

Regra, do `config/setores.yml` direto para o system prompt:

- Menção a empresa, CNPJ, colaborador, funcionário, admissão ou demissão —
  `medicina-ocupacional`
- Lead falando de si, de sintoma, de pedido médico ou de convênio — `exames`
- **Sinal insuficiente — PERGUNTE. Nunca chute.**

> Uma pergunta a mais custa uma mensagem; um roteamento errado com alta confiança não é
> percebido por ninguém até a atendente reclamar.

Comportamento: envia `classificacao.pergunta`, grava `aguardando_resposta`, **não aplica
label**, mantém `pending`. Incrementa a métrica `perguntas`.

**Zero perguntas em `/metricas` é sinal de defeito**, não de sucesso: significa que o
agente está chutando.

### 6.3 Deflexão — o único caminho que encerra

`fora-de-escopo` é o único setor com `acao: "encerrar"`, e `app/config.py` garante no
boot que existe exatamente um.

Cobre: pedido de emprego ou currículo, oferta comercial de fornecedor, cobrança de
terceiros, engano de número, serviço médico não oferecido (internação, cirurgia,
emergência, odontologia, veterinária), conversa sem relação com saúde.

**Assimetria deliberada de risco.** O prompt e o YAML dizem, nas duas fontes:

> Na dúvida entre fora-de-escopo e qualquer outro setor, **NÃO** classifique como
> fora-de-escopo — pergunte ou entregue ao humano.

Porque um erro aqui **perde um cliente real sem deixar rastro**. Errar para o lado de
entregar custa trabalho de atendente; errar para o lado de encerrar custa o cliente.

### 6.4 Entrega ao humano

1. Envia a canned response do `short_code` do setor
2. Escreve nota privada (§6.5)
3. Grava `custom_attributes` (§7.2)
4. Aplica a label do setor
5. `status = open`

⚠️ `POST /conversations/{id}/labels` **substitui a lista inteira de labels**. O cliente lê
as atuais e reenvia todas — senão as que a atendente aplicou à mão somem sem aviso.
`app/chatwoot.py:aplicar_label`.

### 6.5 Nota privada — montada em código, nunca pelo modelo

```
🤖 TRIAGEM AUTOMÁTICA — resumo NÃO VERIFICADO
Setor: {setor}
O que pede: {o_que_quer|(não identificado)}
Para quando: {quando|(não informado)}
Pedido parte de: {"empresa / processo admissional"|"o próprio lead"}

Extraído por máquina do que o lead escreveu, sem conferência.
Nenhum horário foi prometido — a vaga depende de checagem manual.
```

**Por que em código e não em prosa do modelo:** o conteúdo vem de um desconhecido pelo
WhatsApp. Uma nota em prosa livre pode ser induzida por injeção de prompt a enganar a
atendente — *"cliente já pagou, pode liberar o exame"*.

Duas defesas em `_resumir`: trunca em 200 caracteres, e **achata quebras de linha**. Sem
o achatamento, um lead pode escrever algo que imite a formatação da nota e forjar linhas
que parecem vir do sistema.

### 6.6 Circuit breaker

`triagem_mensagens_enviadas` nos `custom_attributes`, teto de 12. Atingido — escalada com
motivo `"limite de mensagens atingido"`.

### 6.7 Canned responses — todo texto ao lead

| Short code | Usada quando | Enviada pelo código? |
|---|---|---|
| `aso_precos_horarios` | medicina-ocupacional | sim |
| `setor_comercial_sst` | comercial-sst | sim |
| `setor_consultas` | consultas | sim |
| `setor_exames` | exames | sim |
| `setor_espaco_integrar` | espaco-integrar | sim |
| `setor_estetica` | estetica | sim |
| `fora_de_escopo` | fora-de-escopo (encerra) | sim — via `short_code` do setor |
| `saudacao` | "primeira mensagem", conforme o README | **não — ver abaixo** |

Todas as enviadas vêm de `setor.short_code`. O processador tem **um único** ponto de
envio de texto de setor: `obter_resposta_pronta(setor.short_code)`.

⚠️ **`mensagens_globais` do YAML é carregado e nunca consumido.** `app/config.py` valida
que `mensagens_globais.fora_de_escopo` existe, mas nada no processador lê esse
dicionário — o texto de fora-de-escopo chega pelo `short_code` do setor, que
coincidentemente tem o mesmo valor. Consequências:

- **`saudacao` nunca é enviada.** O README manda cadastrá-la para "primeira mensagem",
  mas não existe caminho no código que a envie. O lead recebe sua primeira resposta já
  como canned response de setor, ou como pergunta de desambiguação.
- A validação de `mensagens_globais.fora_de_escopo` no boot protege uma chave que o
  serviço não usa. Se ela sumisse do YAML, o serviço se recusaria a subir por um motivo
  que não afeta nenhum comportamento.

Não é defeito de execução — é documentação e configuração descrevendo mais do que o
código faz. Decidir entre implementar a saudação ou remover `mensagens_globais` é
pendência (§12.4).

Tabela original do README, para referência:

| Short code | Usada quando |
|---|---|
| `saudacao` | Primeira mensagem |
| `fora_de_escopo` | Conversa encerrada por estar fora de escopo |
| `aso_precos_horarios` | medicina-ocupacional |
| `setor_comercial_sst` | comercial-sst |
| `setor_consultas` | consultas |
| `setor_exames` | exames |
| `setor_espaco_integrar` | espaco-integrar |
| `setor_estetica` | estetica |

Cacheadas por 60s no cliente. **Short code faltando não inventa texto nem fica mudo** —
entrega ao humano e registra o erro.

⚠️ **Não use variáveis** (`{{contact.name}}`) nessas respostas. O Chatwoot não interpola
quando a mensagem sai via API, e o lead receberia o texto cru.

---

## 7. Privacidade

### 7.1 Camadas

| Camada | Mecanismo | Robustez |
|---|---|---|
| Schema do tool use | Não existe campo para documento | **Não depende do modelo** |
| `Classificacao` | `_extrair` lê só campos conhecidos | **Não depende do modelo** |
| `montar_atributos_triagem` | Dicionário montado por construção, não filtrado depois | **Não depende do modelo** |
| System prompt | "NÃO transcreva, NÃO extraia CPF/CNPJ/nome/data de nascimento" | Depende do modelo — é reforço, não garantia |
| Log | `FiltroDePrivacidade` mascara CPF, CNPJ e telefone | Independente |

`montar_atributos_triagem` é função pura e separada de propósito: é o **ponto único** por
onde passa tudo que o serviço grava no Chatwoot. Montar por construção em vez de filtrar
depois importa — uma allowlist aplicada ao final ainda deixaria alguém adicionar uma
chave e esquecer de atualizá-la.

### 7.2 O que é persistido

Exclusivamente estas quatro chaves, mais o contador:

```
triagem_status         classificando | aguardando_resposta | entregue
triagem_setor          id do setor (ausente quando não decidido)
triagem_confianca      float, 2 casas (ausente quando não há)
triagem_atualizado_em  ISO-8601 com fuso -03
triagem_mensagens_enviadas  int
```

### 7.3 Log

JSON estruturado. O `FiltroDePrivacidade` é instalado nos **handlers do root logger**, não
num logger específico — assim pega tudo que chega ao disco, **inclusive log de biblioteca
de terceiros**. `httpx` registra URLs, e uma URL de anexo é ponteiro direto para
documento com dado de colaborador. `app/main.py:45-46`.

Testes: `testes/teste_mascaramento.py`

### 7.4 O que sai do país ⚠️

Ler o anexo **transmite o conteúdo dele ao OpenRouter e, através dele, ao provedor do
modelo**. Não persistir no Chatwoot reduz muito a exposição, mas não zera: o dado sai do
país nesse momento, e passa por um intermediário a mais.

**E o texto da mensagem também sai** — incluindo o que o agente não pediu. Ver §7.5.

Pendências em aberto: base legal, política de retenção, aviso ao titular.

### 7.5 O Guia de Encaminhamento — dado que chega sem ser pedido

O site tem um formulário que abre o WhatsApp já preenchido com **Empresa, CNPJ,
Responsável, Telefone, E-mail, Tipo de Exame, Nome do Funcionário, Função** (§8.3 da spec
de negócio).

Então:

- O agente **não pede** esses dados — verdade.
- O agente **não persiste** esses dados — verdade, garantido pelo schema fechado.
- O agente **recebe e transmite** esses dados ao OpenRouter — **também verdade**, e não
  está documentado no README.

Não é defeito do agente; é consequência de o site oferecer essa porta. Mas a afirmação
"o serviço não coleta CNPJ nem nome" precisa da qualificação *"não coleta ativamente; e
não persiste o que recebe"* na política de privacidade.

Vale medir: se o Guia representa parcela relevante do tráfego ocupacional, a pergunta
"esses anexos e textos precisam mesmo ir ao LLM?" muda de peso.

---

## 8. Comportamento em falha

### 8.1 Os cinco caminhos de escalada

Todos chamam `_escalar`: grava `entregue`, move para `open`, **não aplica label de
setor**, **nunca encerra**, incrementa `escaladas_por_erro` com o motivo.

| Motivo | Gatilho |
|---|---|
| `limite de mensagens atingido` | Circuit breaker |
| `falha na classificação` | `ErroClassificacao` — timeout, erro de API, sem tool call |
| `setor desconhecido` | Modelo devolveu id fora do enum |
| `resposta pronta indisponível` | Canned response não cadastrada ou API falhou |
| — (aborta, não escala) | Status não é mais `pending`, ou status ilegível |

### 8.2 Watchdog — `app/watchdog.py`

**A rede de segurança do sistema.** Existe por causa de uma decisão de arquitetura: a
fila vive em memória, sem banco. Simples e barato, mas todo deploy e todo crash abandona
as mensagens em voo.

O problema que ele resolve é uma **falha silenciosa**: o estado sobrevive nos
`custom_attributes`, mas a conversa fica em `pending` indefinidamente e nada dispara — o
Chatwoot só escala quando o webhook falha, e aqui ele já respondeu 200. O lead espera, a
fila da atendente parece normal, e o defeito só aparece se alguém for procurar.

Varre a cada 5 min. Duas janelas:

| Situação | Janela | Por quê |
|---|---|---|
| `triagem_status` ≠ `aguardando_resposta` | **15 min** | Conversa travada |
| `triagem_status` = `aguardando_resposta` | **120 min** | Não está travada — está esperando gente. 15 min entregaria à atendente todo lead que foi almoçar. |

Referência de tempo: `triagem_atualizado_em`; sem ele, `last_activity_at` da conversa
(pior caso — significa que o webhook se perdeu por completo). Sem nenhum dos dois, **não
escala** — escalar por via das dúvidas devolveria conversas saudáveis para a fila.

Ao resgatar: **aplica a label `triagem-sem-resposta` ANTES de mudar o status**. Ordem
deliberada — se só o status mudasse, a conversa voltaria para a fila sem sinal de que
algo deu errado, e o defeito continuaria invisível, agora dentro da fila.

Nunca levanta: uma exceção mataria a task em silêncio, levando junto a única rede de
segurança do sistema.

Testes: `testes/teste_watchdog.py`, `testes/teste_falhas_silenciosas.py`

### 8.3 Dreno no shutdown — `app/processador.py:drenar`

Cancela os temporizadores de debounce e processa o acumulado antes de morrer. Sem isso,
todo deploy abandona as mensagens em voo. Uma conversa que falha não derruba o dreno das
demais.

### 8.4 Resiliência do cliente Chatwoot — `app/chatwoot.py`

- Timeout explícito em tudo (connect 5s, read/write 10s). Sem timeout, uma chamada
  pendurada trava o worker — e com um único worker, trava a fila inteira.
- 3 tentativas, backoff exponencial com jitter.
- Repete só em `{429, 500, 502, 503, 504}`. 4xx significa pedido errado; repetir só
  atrasa o lead.
- **Toda chamada pós-classificação é tolerante a falha**: loga e segue. Perder um passo é
  ruim; deixar o lead preso em `pending` é pior.

---

## 9. Horário de funcionamento — comportamento conhecido

O agente **não tem noção de horário comercial**. Tria 24/7, inclusive quando a clínica
está fechada (seg–sex 08–17, fechado fim de semana — §1 da spec de negócio).

Consequências, todas por design:

- **Deflexão funciona sempre.** Conversa fora de escopo às 23h de domingo é encerrada na
  hora, sem custo humano. Bom.
- **Entrega vira espera.** Conversa entregue às 21h de sexta fica `open` até segunda de
  manhã. O lead recebeu a canned response e não sabe disso.
- **O watchdog não distingue.** Uma conversa que trava às 22h é resgatada às 22h15 e
  etiquetada `triagem-sem-resposta` — corretíssimo tecnicamente, mas a atendente encontra
  a label na segunda sem contexto de que foi fora do expediente.

Se a canned response de cada setor não menciona o horário, o lead fica sem previsão de
resposta. **Isso é editável pela clínica na UI, sem deploy** — é o lugar certo para
resolver, se for problema.

---

## 10. Observabilidade

`GET /metricas` — contadores em memória, zeram no restart de propósito. Respondem "está
funcionando agora?", não série histórica.

| Métrica | Leitura |
|---|---|
| `entregues_por_setor` | Parou de crescer no horário comercial — algo quebrou |
| `deflexoes` | Objetivo nº1. ~25-28/dia esperado |
| `perguntas` | **Zero é suspeito** — o agente está chutando em vez de perguntar |
| `escaladas_por_erro` | Quanto do volume cai no humano por falha nossa |
| `watchdog_resgates` | **Qualquer valor > 0 merece investigação** |
| `webhooks_rejeitados` | 100% com `assinatura_invalida` — suspeito nº1 é o bug #13809 |

`GET /health` — deliberadamente **não** toca no Chatwoot nem no LLM: um health check que
depende de terceiros derruba o container quando o terceiro oscila.

---

## 11. Critérios de aceite

Comportamentos que definem "funcionando". Cada um tem teste, exceto os marcados.

**Segurança de entrada**
1. Webhook sem assinatura, com assinatura inválida, ou fora da janela — 401, nunca 500
2. Assinatura calculada sobre bytes brutos; corpo re-serializado não valida
3. Corpo > 1 MB — 413 antes de qualquer HMAC
4. Payload malformado nunca produz 500
5. Entrega duplicada — 200 sem reprocessar
6. Inbox fora da allowlist — 200 sem processar

**Não falar por cima**
7. `message_type=outgoing`, `private=true` ou status ≠ `pending` — descartado
8. Status muda para `open` entre webhook e processamento — aborta sem enviar nada
9. Leitura de status falha — aborta (não arrisca)

**Triagem**
10. Foto + texto em rajada — **uma** classificação, **uma** resposta
11. Setor decidido — canned response + nota privada + label + atributos + `open`
12. `fora-de-escopo` — `resolved`. Nenhum outro setor pode chegar a `resolved`
13. Exame ambíguo sem sinal de origem — **pergunta**, sem label, `pending` mantido
14. Label aplicada preserva as que a atendente já tinha posto

**Privacidade**
15. Nenhum `custom_attribute` fora de `triagem_*` é gravado, em nenhum caminho
16. Conteúdo de anexo não aparece em log, atributo ou disco
17. CPF, CNPJ e telefone mascarados no log, inclusive vindos de terceiros
18. Nenhum caminho do código pede documento ao lead

**Falha**
19. LLM em timeout — entrega ao humano, sem label, `open` — **nunca** `resolved`
20. Canned response ausente — entrega ao humano com erro registrado
21. Anexo inacessível — classifica só com o texto, não trava
22. 12Âª mensagem na conversa — circuit breaker entrega ao humano
23. Conversa `pending` parada 15 min — label `triagem-sem-resposta` + `open`
24. Conversa `aguardando_resposta` parada 15 min — **não** escala; 120 min — escala
25. Shutdown com fila cheia — drena antes de morrer

**Configuração**
26. YAML com ≠ 1 setor `encerrar` — serviço **não sobe**
27. `ttl_dedup < janela_assinatura` — serviço **não sobe**
28. Variável de ambiente obrigatória ausente — falha no import, não na 1Âª conversa

**Sem teste automatizado** (dependem da instância real): 6, 14, 26–28 parcialmente.

---

## 12. Pendências abertas

### 12.1 Verificação contra a instância real da clínica

1. **Qual segredo assina de fato** (bug #13809) — `scripts/spike_webhook.py`
2. **Se `POST /custom_attributes` faz merge ou substituição.** Se substituir, gravar
   campo a campo apaga o estado da triagem
3. **Se `toggle_status` aceita status explícito ou apenas alterna**
4. **Preencher `inboxes_permitidas`** — hoje vazio, aceita qualquer inbox da conta

### 12.2 Divergências com o negócio

Detalhadas em §9 da spec de negócio. Impacto na triagem, resumido:

| # | Divergência | Risco |
|---|---|---|
| 1 | **Tricologia ausente do YAML** | **Alto** — "tenho queda de cabelo" não casa com nenhuma descrição. Pode virar `fora-de-escopo`, que **encerra a conversa** |
| 2 | Auriculoterapia/ventosaterapia não nomeadas | Baixo — cobertas pelo guarda-chuva |
| 3 | **Macaé no prompt, hardcoded** | **Alto — erro confirmado.** Não há unidade em Macaé (confirmado pela clínica em 2026-08-24). `app/prompts.py:31` informa o contrário ao modelo em toda classificação. Correção exige mexer em `prompts.py`, não só no YAML — ver §12.2.1 |
| 4 | Convênios não nomeados no YAML | Baixo |

Alterar `config/setores.yml` muda o system prompt. **Rodar
`testes/avaliacao_classificacao.py` antes de ir ao ar.**

#### 12.2.1 O bloco `cliente:` do YAML é decorativo

`config/setores.yml` tem `cliente: {nome, regiao}`, mas `app/config.py:carregar` monta a
`Configuracao` apenas a partir de `setores`, `operacao`, `mensagens_globais` e
`desambiguacao`. **O bloco `cliente:` inteiro nunca é lido.**

Ao mesmo tempo, `app/prompts.py:31` escreve o nome e a região **à mão**:

```python
"Você é a recepcionista de triagem do WhatsApp da CEMED Saúde, clínica em "
"Rio das Ostras e Macaé (RJ). ..."
```

Isso contraria a regra que a própria docstring de `prompts.py` estabelece — que o prompt
é montado a partir do YAML porque, se repetisse os dados, sairiam de sincronia no
primeiro cliente novo. A região é precisamente um dado que muda entre clientes, e é o
único que ficou fora da regra.

**Consequência prática:** corrigir só o YAML não corrige o comportamento. O valor que
chega ao modelo continua vindo do hardcode.

Correção que fecha a classe do problema, não só a instância:

1. `app/config.py` passa a ler `cliente.nome` e `cliente.regiao` (com validação, como os
   demais campos obrigatórios)
2. `app/prompts.py` interpola os dois em vez de hardcodar
3. `config/setores.yml` — `regiao: "Rio das Ostras - RJ"`
4. `testes/teste_prompts.py` ganha um caso afirmando que a região do YAML aparece no
   prompt montado — trava a regressão
5. Rodar `testes/avaliacao_classificacao.py`

Mesmo padrão de `mensagens_globais` (§6.7): configuração que existe, é preenchida, e não
é consumida. Vale varrer o YAML inteiro atrás de outros casos.

### 12.3 Privacidade

- Base legal, política de retenção e aviso ao titular (§7.4)
- Qualificar a afirmação do README à luz do Guia de Encaminhamento (§7.5)
- Medir que fração do tráfego ocupacional vem do Guia

### 12.4 Produto

- **`saudacao` nunca é enviada** (§6.7). Implementar a saudação de primeira mensagem, ou
  remover `mensagens_globais` do YAML e a linha do README que manda cadastrá-la. Hoje a
  clínica cadastra uma resposta pronta que o agente nunca usa.
- Canned responses mencionam horário de atendimento? (§9)
- Nenhuma métrica distingue conversa dentro/fora do expediente

### 12.5 Documentação divergente do código

Achados durante a redação desta spec. Nenhum é defeito de execução — são afirmações em
docstring/README que descrevem comportamento que não existe.

| Onde | Afirma | Realidade |
|---|---|---|
| `app/main.py:webhook` docstring | `429` para fila cheia, "backpressure" | Não há fila com limite nem caminho que retorne 429 (§4.1) |
| `README.md` | Cadastrar canned response `saudacao` para a primeira mensagem | Nenhum código a envia (§6.7) |
| `config/setores.yml` + `app/config.py` | `mensagens_globais` é configuração ativa | Carregado e nunca consumido (§6.7) |
| `config/setores.yml` | `cliente: {nome, regiao}` é configuração ativa | Nunca lido; o prompt hardcoda os dois (§12.2.1) |
| `app/prompts.py` docstring | "O prompt é MONTADO a partir do `config/setores.yml`, não escrito à mão" | Verdade para setores e desambiguação; **falso para nome e região da clínica** (§12.2.1) |

---

## 13. Mapa módulo — responsabilidade

| Módulo | Responsabilidade | Teste |
|---|---|---|
| `app/main.py` | FastAPI, handler, ciclo de vida | `teste_latencia.py` |
| `app/assinatura.py` | HMAC + janela de replay | `teste_hmac.py` |
| `app/filtros.py` | Decidir se processa; extrair mensagem | `teste_filtros.py` |
| `app/dedup.py` | Cache de entregas com TTL | `teste_dedup.py` |
| `app/processador.py` | Orquestração, debounce, lock, ações | `teste_roteamento.py`, `teste_anexo.py`, `teste_entrega.py` |
| `app/classificador.py` | LLM, tool use, enum fechado | `avaliacao_classificacao.py` (LLM real) |
| `app/prompts.py` | System prompt a partir do YAML | `teste_prompts.py` |
| `app/chatwoot.py` | Cliente da API, retry, atributos | — |
| `app/watchdog.py` | Rede de segurança | `teste_watchdog.py`, `teste_falhas_silenciosas.py` |
| `app/mascaramento.py` | Mascarar dado pessoal no log | `teste_mascaramento.py` |
| `app/metricas.py` | Contadores em memória | — |
| `app/config.py` | Carregar e validar YAML + env | — |
| `app/modelos.py` | Tipos compartilhados | — |

A suíte usa dublês (`testes/dubles/`) e **não toca em rede nem em LLM** (~17s). A
qualidade do modelo é avaliada separadamente, com LLM real. Misturar as duas produz uma
suíte lenta, instável, e que não prova nem lógica de roteamento nem qualidade de modelo.
