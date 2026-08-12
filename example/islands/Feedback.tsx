/**
 * A form island that progressively enhances a real form.
 *
 * Server-rendered it is an ordinary <form> that POSTs to /api/feedback and
 * works with JavaScript disabled. Once hydrated, the submit handler intercepts
 * and sends the same request with fetch(), so the page does not navigate.
 *
 * The CSRF token arrives as a prop because the island re-renders itself on the
 * client and has to reproduce the hidden field the server put there.
 */

import { computed, signal } from "stoneware/signals";

type Status = "idle" | "sending" | "sent" | "error";

const status = signal<Status>("idle");
const message = signal("");

const buttonLabel = computed(() => (status.value === "sending" ? "Sending…" : "Send"));
const busy = computed(() => status.value === "sending");
const messageClass = computed(() => `feedback__msg ${status.value}`);

export interface FeedbackProps {
  token: string;
  fieldName: string;
  /** Which documentation page the note refers to. */
  page: string;
}

export default function Feedback({ token, fieldName, page }: FeedbackProps) {
  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;

    // Snapshot the fields before flipping status: signal effects run
    // synchronously, so setting "sending" disables the input, and disabled
    // controls are omitted from FormData.
    const body = new FormData(form);

    status.value = "sending";
    message.value = "";

    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
        body,
      });
      const result = (await response.json()) as { ok?: boolean; error?: string };

      if (!response.ok || !result.ok) {
        status.value = "error";
        message.value = result.error ?? "Something went wrong.";
        return;
      }

      status.value = "sent";
      message.value = "Thanks — noted.";
      form.reset();
    } catch {
      status.value = "error";
      message.value = "Network error. Try again.";
    }
  }

  return (
    <form class="feedback" action="/api/feedback" method="POST" onSubmit={onSubmit}>
      <input type="hidden" name={fieldName} value={token} />
      <input type="hidden" name="page" value={page} />
      <label for="feedback-note">Anything unclear on this page?</label>
      <div class="feedback__row">
        <input
          id="feedback-note"
          type="text"
          name="note"
          placeholder="What tripped you up?"
          required={true}
          disabled={busy}
        />
        <button type="submit" class="btn" disabled={busy}>
          {buttonLabel}
        </button>
      </div>
      <p class={messageClass}>{message}</p>
    </form>
  );
}
