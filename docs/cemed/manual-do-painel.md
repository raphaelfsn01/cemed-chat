# Manual do painel — CEMED Chat

> Para aprender a operar o sistema e para treinar a equipe da clínica.
> Cada tela segue o mesmo formato: **para que serve · quem acessa · como chegar · o que fazer ·
> erros comuns**. Os marcadores `[print: …]` são os lugares das imagens.

**Endereço do painel:** https://cemed.vortiatech.com

---

## Os quatro papéis

Quem pode o quê. Cada papel enxerga tudo do papel anterior e mais um pouco.

| Papel | Quem é na CEMED | O que faz |
|---|---|---|
| **Atendente** (`agent`) | recepção | atende conversas, mexe em contatos e no funil |
| **Gestor** (`manager`) | quem coordena a recepção | tudo acima, mais funis, agente de IA, relatórios |
| **Admin** (`admin`) | você | tudo acima, mais WhatsApp, LGPD, dados da empresa |
| **Dono do servidor** | você | atualizar o sistema |

Comece todo mundo como **Atendente**. Papel a mais é risco a mais, e subir depois leva dez segundos.

---

# Parte 0 — Antes de treinar alguém

Hoje existe **uma conta só** no sistema: a sua. Sem contas para a equipe não há o que treinar.

## 0.1 Criar as contas da equipe

**Para que serve:** dar acesso a cada pessoa, com nome próprio. Conta compartilhada apaga o
histórico de quem fez o quê — e o Audit Log deixa de valer.

**Quem acessa:** qualquer um vê a Equipe; convidar exige Admin.

**Como chegar:** menu **Organização → Equipe**.

**O que fazer:**

1. Clique em **Convidar membros**.
2. Escreva os e-mails, um por linha, no campo **Emails**.
3. Escolha o papel **Atendente**.
4. Envie. Cada pessoa recebe um e-mail e cria a própria senha.

Na mesma tela você define, por pessoa:

- **Capacidade** — quantas conversas ela aguenta ao mesmo tempo. A distribuição automática
  respeita esse número.
- **Disponível** — quem está fora não recebe conversa nova.
- **Horário** e **Fuso horário** — a janela em que ela atende.

`[print: Organização → Equipe, com a lista de membros]`

**Erros comuns:** convidar como Admin "para não dar trabalho depois". Admin apaga dados de
paciente e mexe no WhatsApp da clínica.

## 0.2 Ligar a verificação em duas etapas

**Para que serve:** o painel tem conversa de paciente. Senha sozinha não basta.

**Quem acessa:** cada pessoa na própria conta.

**Como chegar:** menu **Organização → Segurança**.

**O que fazer:**

1. Em **MFA (TOTP)**, ative e leia o QR com o app autenticador do celular.
2. Guarde os **Códigos de recuperação** fora do celular. São a saída se o aparelho sumir.
3. Em **Sessões ativas**, encerre o que você não reconhecer.

`[print: Organização → Segurança]`

---

# Parte 1 — Recepção: o dia a dia

Esta é a parte que a equipe usa o tempo todo. Se alguém só ler isto, já trabalha.

## 1.1 Inbox — onde o atendimento acontece

**Para que serve:** todas as conversas de WhatsApp, com você e a IA atendendo lado a lado.

**Quem acessa:** todos.

**Como chegar:** menu **Atendimento → Inbox**.

### As cinco abas

| Aba | O que tem nela |
|---|---|
| **Fila** | conversas sem responsável. É daqui que se puxa trabalho. |
| **Minhas** | as suas. Comece o dia por aqui. |
| **Todas** | tudo o que você tem permissão de ver. |
| **Fechadas** | encerradas, para consulta. |
| **IA** | as que o agente está conduzindo sozinho. |

### O estado de cada conversa

- **IA atendendo** — o agente responde sozinho. Você pode ler sem interferir.
- **Em atendimento** — alguém da equipe assumiu.
- Sem marca — está na fila, esperando.

### O que fazer

1. **Assumir** — a conversa passa a ser sua e a IA para de responder nela.
2. **Responder** — escreva embaixo e tecle **Enter**. **Shift+Enter** quebra linha.
3. **Nota interna** — o botão ao lado de *Responder*. O texto fica amarelo e **só o time vê**.
   Use para "paciente já ligou ontem", nunca para falar com o paciente.
4. **Transferir** — manda a conversa para outra pessoa da equipe.
5. **Adiar** — some da sua lista por **1 hora**, **3 horas** ou **24 horas** e volta sozinha.
6. **Fechar** — encerra. O sistema pede confirmação.
7. **Devolver ao automático** — aparece quando um humano assumiu e devolve a conversa para a IA.
8. **Ver contato** — abre a ficha da pessoa, com histórico.

`[print: Inbox com uma conversa aberta, mostrando o cabeçalho e os botões]`

### Ferramentas do campo de escrita

- **`/` no começo da mensagem** abre as **respostas rápidas**. Digite parte do título para filtrar.
- **Clipe** anexa arquivo, imagem ou áudio.
- **Rascunho da IA** escreve uma sugestão de resposta para você revisar antes de enviar.
- **Emoji** — disponível, mas o agente não usa emoji com paciente, e a recepção também não deveria.

### Atalhos de teclado

| Tecla | Faz |
|---|---|
| `j` / `k` | desce e sobe na lista |
| `r` | pula para o campo de resposta |
| `a` | assume a conversa |
| `e` | fecha a conversa (pede confirmação) |
| `Shift + ?` | mostra esta lista na tela |

**Erros comuns:**

- Responder sem **Assumir**: a IA pode responder junto e o paciente recebe duas vozes.
- Usar **Nota interna** achando que está falando com o paciente. Olhe a cor antes de enviar.
- **Fechar** conversa que só está esperando retorno. Para isso existe **Adiar**.

## 1.2 Radar — o que está esfriando

**Para que serve:** mostrar quem ficou sem resposta e corre risco de morrer no silêncio.

**Quem acessa:** todos.

**Como chegar:** menu **Atendimento → Radar**.

**O que fazer:** olhe uma vez de manhã e uma no fim do dia. Cada linha traz o nível — **Crítico**,
**Em risco** ou **Em voo** — e há quanto tempo está parada ("parado há 6h"). O botão **Assumir**
puxa a conversa para você.

`[print: Radar de risco com linhas em Crítico e Em risco]`

**Erros comuns:** tratar o Radar como lista de tarefas do dia. Ele é rede de segurança: se algo
aparece ali, já passou do ponto.

## 1.3 Respostas rápidas

**Para que serve:** guardar o que a clínica repete o dia inteiro.

**Quem acessa:** todos.

**Como chegar:** menu **Atendimento → Respostas rápidas**.

**O que fazer:**

1. Crie com **Título**, **Mensagem** e, se quiser, um **Atalho**.
2. Marque **Compartilhar com a equipe** para todos usarem.
3. Use `{{primeiro_nome}}` dentro do texto: o sistema troca pelo nome da pessoa.
4. Na conversa, digite `/` e escolha.

`[print: tela de Respostas rápidas com o formulário aberto]`

**Erros comuns:** guardar preço em resposta rápida. A clínica não informa valor por WhatsApp.

## 1.4 Contatos

**Para que serve:** a ficha da pessoa do outro lado e o histórico dela.

**Quem acessa:** todos veem; anonimizar exige Admin.

**Como chegar:** menu **CRM → Contatos**.

**O que fazer:**

- **Novo contato** — cria à mão. Telefone no formato internacional (`+5522999990000`).
- **Editar** — nome, telefone, e-mail, **Tags**.
- **Timeline** — tudo que aconteceu com a pessoa, em ordem.
- **Resolver merge** — quando a mesma pessoa aparece duas vezes, junta as duas fichas.

`[print: ficha de um contato, abas Visão geral e Timeline]`

**Erros comuns:** apagar um contato para "limpar". Não existe apagar — existe **anonimizar**, que
é irreversível e só deve ser usado com pedido formal do paciente. Ver a Parte 5.

## 1.5 Kanban — o funil

**Para que serve:** ver em que ponto está cada atendimento.

**Quem acessa:** todos.

**Como chegar:** menu **CRM → Kanban**.

**O que fazer:**

- Arraste o card entre as etapas.
- **Novo Lead** cria um card à mão.
- No card: **Etapa**, **Responsável**, **Tags**, **Fechamento previsto**, **Descrição**.
- **Marcar como perdido** pede o **Motivo** — é ele que vira relatório depois.
- Selecione vários cards para **Mover para…**, **Atribuir a…**, **Tag…** ou **Excluir**.

`[print: quadro do Kanban com as etapas da CEMED]`

**Erros comuns:** arrastar card sem falar com o paciente. O card reflete a realidade; ele não a cria.

---

# Parte 2 — Gestão

## 2.1 Funis

**Para que serve:** as etapas do atendimento, o vocabulário e os motivos de perda.
**Quem acessa:** Gestor. **Como chegar:** menu **CRM → Funis**.

Você define as **Etapas deste funil**, o **Vocabulário** (como o sistema chama cada coisa) e os
**Motivos de perda**. Em *Para onde o card vai em cada passo* você escolhe a etapa de destino —
ou **Não mover o card**.

`[print: Funis, com as etapas da CEMED]`

**Cuidado:** apagar coluna não tem volta pela tela.

## 2.2 Distribuição de atendimento

**Para que serve:** quem recebe o paciente novo e o que cada atendente enxerga.
**Quem acessa:** Gestor. **Como chegar:** menu **Organização → Distribuição de atendimento**.

Define **Quem recebe o cliente novo**, **O que cada atendente enxerga**, **Tentativas antes de
desistir** e a **Espera entre tentativas**.

## 2.3 Agente de IA

**Para que serve:** quem atende por você quando ninguém assumiu.
**Quem acessa:** Gestor. **Como chegar:** menu **Agente de IA → Agentes → Atendente CEMED**.

O que existe na tela:

- **Quem é este agente** — nome, descrição (só para a equipe) e ordem de preferência.
- **Instruções** — o texto que manda no comportamento dele. É o documento mais importante do
  sistema.
- **A inteligência que ele usa** — Empresa, Modelo e a chave de acesso. Hoje: **Google · Gemini
  2.5 Flash**, escolhido por medição (ver `benchmark-modelos-2026-09.md`).
- **Estilo de resposta** — "Responder em várias mensagens curtas" e o **Tamanho máximo por bolha**,
  hoje em **110**. É o que faz a resposta chegar em balões, como gente digitando.
- **O que o agente pode fazer** — as ações liberadas.

**Publicar uma mudança:** altere, clique em **Salvar rascunho** e depois em **Publicar 0.7**. A
versão no ar aparece no selo do topo. Só o que está publicado vale para o paciente.

`[print: tela do agente, card "A inteligência que ele usa"]`

**Erros comuns:** editar e esquecer de publicar. Rascunho não atende ninguém.

## 2.4 As outras telas de IA

| Tela | Para que serve | Quem acessa |
|---|---|---|
| **Follow-ups** | como o agente retoma conversa que esfriou | Gestor |
| **Roteadores** | qual agente pega qual conversa | Gestor |
| **Conhecimento** | materiais que o agente consulta antes de responder | Gestor |
| **Memória** | o que ele já aprendeu sobre a operação (**Documento da organização** e **Aprendizados**) | Gestor |
| **Skills** | ações que ele executa sozinho | Gestor |
| **Casos** | atendimentos que ele conduziu, do início ao fim | Atendente |
| **Alertas** (Central de avisos) | o que a IA achou e precisa de decisão sua | todos |
| **Propostas** | melhorias que a IA sugere para si mesma | todos |
| **Uso e orçamento** | quanto a IA consumiu e o teto do mês | Gestor |

## 2.5 Relatórios

- **Desempenho** (todos) — **Conversas**, **Ganhos** e **Perdidos** dos últimos 30 dias, por
  atendente.
- **Evolução da IA** (Gestor) — se o agente está melhorando e onde erra.
- **Audit Log** (Gestor) — quem fez o quê e quando. Não se apaga. Filtros por **Ação contém**,
  **Tipo de recurso** e período.

---

# Parte 3 — Dono

| Tela | Para que serve |
|---|---|
| **Conexões** | conectar e reconectar o WhatsApp da clínica |
| **Credenciais** | a chave do provedor de IA (**Adicionar credencial** → Provider, Label, API key) |
| **Organização** | razão social, idioma, fuso, **Retenção de mídia (dias)**, **DPO email** |
| **LGPD** | pedidos de exportação e exclusão feitos por pacientes |
| **API Tokens** | chaves para outro sistema conversar com o CRM. O token aparece **uma vez só** |
| **Webhooks** | avisar outro sistema quando algo acontece aqui |
| **Atualização do sistema** | instalar a versão nova do painel |

**Sobre atualizar:** a tela mostra **O que muda** e o botão de atualizar; quando não há versão
nova, ela diz *"É a mais recente. Não há nada a fazer."* Ela atualiza o painel — **não** atualiza
o worker, que é a parte que faz o agente responder. Esse ainda passa por mim (ver Parte 6).

---

# Parte 4 — As regras da CEMED

Valem para o agente **e** para a equipe. Elas estão escritas nas instruções do agente e devem
guiar quem atende.

1. **Nunca informe preço por WhatsApp.** Quem informa valor é a equipe, no atendimento.
2. **Não agende nem confirme horário.** A clínica atende por ordem de chegada; só quem vê a fila
   sabe a disponibilidade.
3. **Urgência vai para uma pessoa, na hora.** Dor no peito, falta de ar, desmaio: acolha em uma
   linha e transfira. Ninguém orienta conduta por WhatsApp.
4. **Não peça documento.** Nem CPF, nem carteirinha, nem foto. Nome e telefone bastam.
5. **Unimed não é atendida.** Avise antes de a conversa avançar. Aceitos: particular, BRASEG,
   Cartão da Família e PAF SERRA-MAR.
6. **Queda de cabelo é escopo.** É Tricologia, com a Dra. Ana Prado — nunca trate como fora de escopo.
7. **Uma unidade só**, em Rio das Ostras. Não existe unidade em Macaé.
8. **Zero emoji** com paciente.

---

# Parte 5 — Perguntas que já apareceram

**"Apago o contato e o agente esquece?"**
Não. Não existe apagar contato: existe **Anonimizar contato (LGPD)**, que é irreversível, exige
Admin e uma justificativa de pelo menos 10 caracteres. Ela limpa o contato, as conversas, as
mensagens, as atividades e os cards — mas **não limpa a memória do agente** (o resumo que ele
guarda de cada atendimento). Para zerar a memória, fale comigo.

**"Editei e o botão Publicar não habilita."**
O botão só liga quando não há alteração pendente. Salve o rascunho primeiro. Se continuar
desabilitado, passe o mouse por cima: o aviso diz o motivo (número de WhatsApp desconectado,
credencial não validada, campo obrigatório vazio).

**"Por que o agente manda várias mensagens?"**
É proposital: respostas longas são quebradas em balões, como uma pessoa digitando. O limite é
**110 caracteres por balão**, escolhido por medição — abaixo disso a frase quebra no meio.

---

# Parte 6 — O que é seu e o que é meu

| Você resolve no painel | Por quê |
|---|---|
| Convidar equipe, papéis, 2FA | tela própria, sem risco |
| Atender, transferir, adiar, notas, tags, funil | é a operação |
| Instruções do agente, modelo, estilo, publicar versão | versionado e reversível pela tela |
| Credencial de IA e teto de gasto | tela própria |
| Conectar ou reconectar o WhatsApp | tela própria, com QR |
| LGPD: receber pedido, exportar, anonimizar | tela própria, com trilha de auditoria |
| Atualizar o painel | tela própria, com "O que muda" antes |
| Webhooks, API Tokens, Audit Log | tela própria |

| Fale comigo | Por quê |
|---|---|
| Deploy do **worker** | o agente roda em outra imagem, que o CI ainda não publica |
| Limpar a memória do agente de um contato | não existe tela; é escrita direta no banco |
| Liberar contato silenciado por transferência | idem |
| Mudanças de banco (campos, etiquetas, funis novos por migração) | exigem migração versionada |
| Variáveis de ambiente e ajustes do motor | ficam fora do painel, no servidor |
| Saldo e chave da OpenRouter | é conta externa, fora do sistema |
| Erro que aparece sem explicação | preciso do log do worker e da fila |

---

## Apêndice — a área `/admin`

Existe uma área separada, `/admin`, para quem é dono do servidor: tenants, incidentes, uso e
administração da plataforma. Ela não faz parte da operação da clínica e não entra no treinamento
da equipe.

---

*Última revisão: setembro/2026 · sistema na versão v0.4.0 · agente na versão 0.6 (Gemini 2.5 Flash).*
