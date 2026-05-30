'use client';
import { cn } from '../../lib/cn';
import { buttonVariants } from '../ui/button-variants';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import {
  type SyntheticEvent,
  useEffect,
  useEffectEvent,
  useState,
  useTransition,
} from 'react';
import { Collapsible, CollapsibleContent } from '../ui/collapsible';
import { cva } from 'class-variance-authority';
import { usePathname } from 'next/navigation';
import {
  actionResponse,
  pageFeedback,
  type ActionResponse,
  type PageFeedback,
} from './schema';
import { z } from 'zod/mini';

const rateButtonVariants = cva(
  'inline-flex items-center gap-2 px-3 py-2 rounded-full font-medium border text-sm [&_svg]:size-4 disabled:cursor-not-allowed',
  {
    variants: {
      active: {
        true: 'bg-fd-accent text-fd-accent-foreground [&_svg]:fill-current',
        false: 'text-fd-muted-foreground',
      },
    },
  },
);

const pageFeedbackResult = z.extend(pageFeedback, {
  response: actionResponse,
});

/**
 * A feedback component to be attached at the end of page
 */
export function Feedback({
  onSendAction,
}: {
  onSendAction: (feedback: PageFeedback) => Promise<ActionResponse>;
}) {
  const url = usePathname();
  const { previous, setPrevious } = useSubmissionStorage(url, (v) => {
    const result = pageFeedbackResult.safeParse(v);
    return result.success ? result.data : null;
  });
  const [opinion, setOpinion] = useState<'good' | 'bad' | null>(null);
  const [message, setMessage] = useState('');
  const [isPending, startTransition] = useTransition();

  function submit(e?: SyntheticEvent) {
    if (opinion == null) return;

    startTransition(async () => {
      const feedback: PageFeedback = {
        url,
        opinion,
        message,
      };

      const response = await onSendAction(feedback);
      setPrevious({
        response,
        ...feedback,
      });
      setMessage('');
      setOpinion(null);
    });

    e?.preventDefault();
  }

  const activeOpinion = previous?.opinion ?? opinion;

  return (
    <Collapsible
      open={opinion !== null || previous !== null}
      onOpenChange={(v) => {
        if (!v) setOpinion(null);
      }}
      className="border-y py-3"
    >
      <div className="flex flex-row items-center gap-2">
        <p className="text-sm font-medium pe-2">How is this guide?</p>
        <button
          type="button"
          disabled={previous !== null}
          className={cn(
            rateButtonVariants({
              active: activeOpinion === 'good',
            }),
          )}
          onClick={() => {
            setOpinion('good');
          }}
        >
          <ThumbsUp />
          Good
        </button>
        <button
          type="button"
          disabled={previous !== null}
          className={cn(
            rateButtonVariants({
              active: activeOpinion === 'bad',
            }),
          )}
          onClick={() => {
            setOpinion('bad');
          }}
        >
          <ThumbsDown />
          Bad
        </button>
      </div>
      <CollapsibleContent className="mt-3">
        {previous ? (
          <div className="px-3 py-6 flex flex-col items-center gap-3 bg-fd-card text-fd-muted-foreground text-sm text-center rounded-xl">
            <p>Thank you for your feedback!</p>
            <div className="flex flex-row items-center gap-2">
              <a
                href={previous.response?.githubUrl}
                rel="noreferrer noopener"
                target="_blank"
                className={cn(
                  buttonVariants({
                    variant: 'default',
                  }),
                  'text-xs',
                )}
              >
                View on GitHub
              </a>

              <button
                type="button"
                className={cn(
                  buttonVariants({
                    variant: 'secondary',
                  }),
                  'text-xs',
                )}
                onClick={() => {
                  setOpinion(previous.opinion);
                  setPrevious(null);
                }}
              >
                Submit Again
              </button>
            </div>
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <textarea
              required
              aria-label="Leave your feedback"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="border rounded-lg bg-fd-secondary text-fd-secondary-foreground p-3 resize-none focus-visible:outline-none placeholder:text-fd-muted-foreground"
              placeholder="Leave your feedback..."
              onKeyDown={(e) => {
                if (!e.shiftKey && e.key === 'Enter') {
                  submit(e);
                }
              }}
            />
            <button
              type="submit"
              className={cn(buttonVariants({ variant: 'outline' }), 'w-fit px-3')}
              disabled={isPending}
            >
              Submit
            </button>
          </form>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function useSubmissionStorage<Result>(blockId: string, validate: (v: unknown) => Result | null) {
  // react-doctor-disable-next-line react-doctor/no-event-handler -- blockId is hydration input for the localStorage read effect below, not a DOM event handler
  const storageKey = `docs-feedback-${blockId}`;
  const [value, setValue] = useState<Result | null>(null);
  // react-doctor-disable-next-line react-doctor/no-event-handler -- validate is wrapped with useEffectEvent so the localStorage read effect stays stable; it is not a DOM event handler
  const validateCallback = useEffectEvent(validate);

  useEffect(() => {
    const item = localStorage.getItem(storageKey);
    if (item === null) return;
    const validated = validateCallback(JSON.parse(item));

    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-derived-state -- value is hydrated from localStorage (a client-only external store), not derived from props/state and not computable during render
    if (validated !== null) setValue(validated);
  }, [storageKey]);

  return {
    previous: value,
    setPrevious(result: Result | null) {
      if (result) localStorage.setItem(storageKey, JSON.stringify(result));
      else localStorage.removeItem(storageKey);

      setValue(result);
    },
  };
}
