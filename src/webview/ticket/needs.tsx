/**
 * What an agent's report needs from the user, and its questions: answered in the report, or at the top of the ticket
 * while it's open (BL-280).
 */
import { useState } from 'preact/hooks';
import {
  type Answer,
  answerComment,
  answerFromText,
  answerOf,
  answersIn,
  choose,
  defaultAnswer,
  picksPicture,
} from '../../features/backlog/report';
import type { ReportView } from '../ticketProtocol';
import { sendComment } from './comments';
import {
  MarkdownBox,
  Rendered,
} from './markdownBox';
import './needs.css';

/**
 * What an agent needs from the user: its text, and its questions. Unanswered questions (local items) are answered by
 * clicking: a choice (its recommendation preselected) or Other…; one Send posts the answers as the user's comment, and
 * the agent goes on from there. Answered ones, and those of tracker-linked items, show what was chosen, read-only.
 */
export function Needs({ report, name, live, atTop }: { report: ReportView; name: string; live: boolean; atTop?: boolean }) {
  const answered = report.answer !== undefined;
  // While the top of the ticket asks its questions (BL-280), the report lists them and points there: one form to fill.
  if (atTop && !answered) return <AnswerAtTop report={report} />;
  const interactive = live && !answered && report.questions.length > 0;
  const [answers, setAnswers] = useState<Answer[]>(() => report.questions.map(defaultAnswer));
  const given = answered ? answersIn(report.questions, report.answer!) : [];
  const shown = interactive ? answers : report.questions.map((q, i) => (answered ? answerFromText(q, given[i] ?? '') : { picked: [], other: '' }));
  const update = (qi: number, change: (a: Answer) => Answer) => setAnswers((all) => all.map((a, i) => (i === qi ? change(a) : a)));
  const texts = report.questions.map((q, i) => answerOf(q, answers[i]));
  const ready = interactive && texts.every(Boolean);
  const submit = () => {
    if (ready) sendComment(answerComment(report.questions.map((question, i) => ({ question, answer: texts[i] }))));
  };
  return (
    <div class={`needs${answered ? ' answered' : ''}`}>
      {report.needs && (
        <>
          <div class="needs-line">
            <i class="codicon codicon-question" /> <strong>Needs from you:</strong>
          </div>
          <Rendered html={report.needs} empty="" />
        </>
      )}
      {answered && <div class="muted">Answered.</div>}
      {report.questions.map((q, qi) => {
        const a = shown[qi];
        const other = q.options.length;
        const type = q.kind === 'several' ? 'checkbox' : 'radio';
        // Mockups to pick (BL-257): each choice is its picture, clicked as a whole; the free answer is "None of these".
        const pictures = picksPicture(q);
        return (
          <fieldset class={`question${pictures ? ' pictures' : ''}`} key={qi}>
            <legend>{q.text}</legend>
            {q.kind === 'text' ? (
              interactive ? (
                <MarkdownBox
                  value={a.other}
                  setValue={(text) => update(qi, (x) => ({ ...x, other: text }))}
                  placeholder="Your answer (Markdown)"
                  label={`Your answer to: ${q.text}`}
                  onSubmit={submit}
                  images={false}
                  minRows={2}
                  autoFocus={qi === 0}
                />
              ) : (
                <div class="answer-text">{a.other}</div>
              )
            ) : (
              <>
                <div class={pictures ? 'picks' : 'choices'}>
                  {q.options.map((o, i) => (
                    <label class={`choice${o.image ? ' pick' : ''}${a.picked.includes(i) ? ' picked' : ''}`} key={i}>
                      {o.image && <img src={o.image} alt={o.text} loading="lazy" />}
                      <span class="pick-line">
                        <input
                          type={type}
                          name={`${name}-${qi}`}
                          checked={a.picked.includes(i)}
                          disabled={!interactive}
                          onChange={() => update(qi, (x) => choose(q, x, i))}
                        />
                        <span>{o.text}</span>
                        {o.recommended && <span class="recommended">recommended</span>}
                      </span>
                    </label>
                  ))}
                </div>
                {q.kind !== 'yesno' && (
                  <label class="choice">
                    <input
                      type={type}
                      name={`${name}-${qi}`}
                      checked={a.picked.includes(other)}
                      disabled={!interactive}
                      onChange={() => update(qi, (x) => choose(q, x, other))}
                    />
                    <span>{pictures ? 'None of these…' : 'Other…'}</span>
                  </label>
                )}
                {q.kind !== 'yesno' &&
                  a.picked.includes(other) &&
                  (interactive ? (
                    <MarkdownBox
                      value={a.other}
                      setValue={(text) => update(qi, (x) => ({ ...x, other: text }))}
                      placeholder={pictures ? 'What to change: the agent draws a new round (Markdown)' : 'Your answer (Markdown)'}
                      label={`Your answer to: ${q.text}`}
                      onSubmit={submit}
                      images={false}
                      minRows={2}
                      autoFocus
                    />
                  ) : (
                    <div class="answer-text">{a.other}</div>
                  ))}
              </>
            )}
          </fieldset>
        );
      })}
      {interactive && (
        <div class="actions-row">
          <button class="button" disabled={!ready} onClick={submit} title="Posts the answers as your comment: the agent goes on from there">
            {report.questions.length > 1 ? 'Send Answers' : 'Send'}
          </button>
        </div>
      )}
    </div>
  );
}

/** An open report's questions, as text, while the state card asks them: "Answer at the top" scrolls up to it. */
function AnswerAtTop({ report }: { report: ReportView }) {
  return (
    <div class="needs at-top">
      <div class="needs-line">
        <i class="codicon codicon-question" /> <strong>Needs from you:</strong>
      </div>
      {report.needs && <Rendered html={report.needs} empty="" />}
      {report.questions.length > 0 && (
        <ul class="needs-questions">
          {report.questions.map((q, qi) => (
            <li key={qi}>{q.text}</li>
          ))}
        </ul>
      )}
      <button
        class="text-button"
        onClick={() => document.querySelector('.review-panel.ask')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        title="The questions are answered in the card at the top of the ticket"
      >
        <i class="codicon codicon-arrow-up" /> Answer at the top
      </button>
    </div>
  );
}
