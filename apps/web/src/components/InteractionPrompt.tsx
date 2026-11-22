import { useState } from 'react';
import type { InteractionRequestEvent, InteractionQuestion } from '@tierwyn/shared';
import { ToolInputDisplay } from './ToolInputDisplay.js';

type Payload = InteractionRequestEvent['payload'];

type Answer = { selection: string[]; text?: string };

export function InteractionPrompt(props: {
  request: Payload;
  disabled: boolean;
  onRespond: (selection: string[], text?: string, answers?: Answer[]) => void;
}) {
  const { request, disabled, onRespond } = props;

  // Multi-question path (AskUserQuestion with >1 entries).
  if (request.kind === 'question' && request.questions && request.questions.length > 0) {
    return (
      <MultiQuestionPrompt
        questions={request.questions}
        disabled={disabled}
        onRespond={(answers) => onRespond([], undefined, answers)}
      />
    );
  }

  // Single-question / permission path.
  return (
    <SinglePrompt
      request={request}
      disabled={disabled}
      onRespond={(selection, text) => onRespond(selection, text)}
    />
  );
}

function SinglePrompt(props: {
  request: Payload;
  disabled: boolean;
  onRespond: (selection: string[], text?: string) => void;
}) {
  const { request, disabled, onRespond } = props;
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');

  const isQuestion = request.kind === 'question';
  const toggle = (id: string) => {
    if (request.multiSelect) {
      setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
    } else {
      onRespond([id], text || undefined);
    }
  };

  // ponytail: AskUserQuestion always gets a free-text escape hatch — the
  // agent's offered options frequently don't fit the operator's intent.
  // Permission-kind (Allow/Deny) stays adapter-gated via allowFreeText.
  const showFreeText = isQuestion || request.allowFreeText;
  const hasText = text.trim().length > 0;
  // Permission-kind too: empty selection + text is handled server-side as a
  // deny-with-message ("No, and tell the agent what to do differently").
  const showCustomSubmit = showFreeText && !request.multiSelect && hasText;

  // For AskUserQuestion the toolInput is { questions: [...] }, which is already
  // rendered as prompt + choices. Showing it again as JSON is duplicate noise.
  // Only render the tool-input box for permission-kind requests (e.g. the bash
  // command in a Write/Bash approval), where it carries information the choices
  // don't.
  const showToolInput = request.kind === 'permission' && request.toolName && request.toolInput;

  return (
    <div className="interaction-prompt" data-kind={request.kind}>
      <div className="interaction-prompt__prompt">{request.prompt}</div>
      {showToolInput && (
        <div className="interaction-prompt__tool">
          <ToolInputDisplay input={request.toolInput} />
        </div>
      )}
      <div className="interaction-prompt__choices">
        {request.choices.map((c) => (
          <button
            key={c.id}
            disabled={disabled}
            className={picked.includes(c.id) ? 'is-selected' : ''}
            onClick={() => toggle(c.id)}
            title={c.description}
          >
            {c.label}
          </button>
        ))}
      </div>
      {showFreeText && (
        <input
          className="interaction-prompt__text"
          placeholder={isQuestion ? 'Or type your own answer' : 'Optional note / other answer'}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {showCustomSubmit && (
        <button
          className="interaction-prompt__submit"
          disabled={disabled}
          onClick={() => onRespond([], text.trim())}
        >
          {isQuestion ? 'Submit custom answer' : 'Deny with message'}
        </button>
      )}
      {request.multiSelect && (
        <button
          className="interaction-prompt__submit"
          disabled={disabled || picked.length === 0}
          onClick={() => onRespond(picked, text || undefined)}
        >
          Submit{picked.length > 0 ? ` (${picked.length})` : ''}
        </button>
      )}
    </div>
  );
}

function MultiQuestionPrompt(props: {
  questions: InteractionQuestion[];
  disabled: boolean;
  onRespond: (answers: Answer[]) => void;
}) {
  const { questions, disabled, onRespond } = props;
  // One selection state per question, keyed by question id.
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  const setPick = (id: string, optionId: string, multiSelect?: boolean) => {
    setPicks((prev) => {
      const cur = prev[id] ?? [];
      if (multiSelect) {
        return { ...prev, [id]: cur.includes(optionId) ? cur.filter((x) => x !== optionId) : [...cur, optionId] };
      }
      return { ...prev, [id]: [optionId] };
    });
  };

  const allAnswered = questions.every((q) => (picks[q.id]?.length ?? 0) > 0 || (texts[q.id] ?? '').trim().length > 0);

  const submit = () => {
    const answers: Answer[] = questions.map((q) => ({
      selection: picks[q.id] ?? [],
      text: texts[q.id]?.trim() ? texts[q.id] : undefined,
    }));
    onRespond(answers);
  };

  return (
    <div className="interaction-prompt interaction-prompt--multi" data-kind="question">
      <div className="interaction-prompt__header">
        The agent has {questions.length} questions
      </div>
      {questions.map((q, qIdx) => {
        const picked = picks[q.id] ?? [];
        const hasText = (texts[q.id] ?? '').trim().length > 0;
        return (
          <div key={q.id} className="interaction-prompt__question">
            {q.header && <div className="interaction-prompt__question-header">{q.header}</div>}
            <div className="interaction-prompt__prompt">
              <span className="interaction-prompt__question-index">{qIdx + 1}.</span> {q.prompt}
            </div>
            <div className="interaction-prompt__choices">
              {q.choices.map((c) => (
                <button
                  key={c.id}
                  disabled={disabled}
                  className={picked.includes(c.id) ? 'is-selected' : ''}
                  onClick={() => setPick(q.id, c.id, q.multiSelect)}
                  title={c.description}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <input
              className="interaction-prompt__text"
              placeholder="Or type your own answer"
              value={texts[q.id] ?? ''}
              disabled={disabled}
              onChange={(e) => setTexts((t) => ({ ...t, [q.id]: e.target.value }))}
            />
            {q.multiSelect && (
              <div className="interaction-prompt__hint">
                Select all that apply ({picked.length} chosen){hasText ? ' + custom' : ''}
              </div>
            )}
          </div>
        );
      })}
      <button
        className="interaction-prompt__submit"
        disabled={disabled || !allAnswered}
        onClick={submit}
      >
        Submit {questions.length} {questions.length === 1 ? 'answer' : 'answers'}
      </button>
    </div>
  );
}
