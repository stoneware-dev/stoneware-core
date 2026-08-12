/**
 * A form island that progressively enhances a real form.
 *
 * Server-rendered, it is an ordinary <form> that POSTs to /api/subscribe and
 * works with JavaScript disabled. Once hydrated, the submit handler intercepts
 * and does the same POST with fetch(), so the page does not navigate.
 *
 * The CSRF token arrives as a prop because the island re-renders itself on the
 * client and has to reproduce the hidden field the server put there.
 */

import { computed, signal } from "kiln/signals";
import { subscriberCount } from "../lib/state.ts";

type Status = "idle" | "sending" | "subscribed" | "error";

const status = signal<Status>("idle");
const message = signal("");

const buttonLabel = computed(() => (status.value === "sending" ? "Subscribing…" : "Subscribe"));

export interface NewsletterProps {
  token: string;
  fieldName: string;
}

export default function Newsletter({ token, fieldName }: NewsletterProps) {
  async function onSubmit(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;

    // Snapshot the fields *before* flipping status: signal effects run
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
        message.value = result.error ?? "Something went wrong. Try again.";
        return;
      }

      status.value = "subscribed";
      message.value = "Thanks — check your inbox to confirm.";
      subscriberCount.value++;
      form.reset();
    } catch {
      status.value = "error";
      message.value = "Network error. Try again.";
    }
  }

  return (
    <form class="newsletter" action="/api/subscribe" method="POST" onSubmit={onSubmit}>
      <input type="hidden" name={fieldName} value={token} />
      <label for="newsletter-email">Get new posts by email</label>
      <div class="newsletter-row">
        <input
          id="newsletter-email"
          type="email"
          name="email"
          placeholder="you@example.com"
          required={true}
          disabled={computed(() => status.value === "sending")}
        />
        <button type="submit" disabled={computed(() => status.value === "sending")}>
          {buttonLabel}
        </button>
      </div>
      <p class={computed(() => `newsletter-message ${status.value}`)}>{message}</p>
    </form>
  );
}
