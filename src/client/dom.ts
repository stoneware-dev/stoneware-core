/**
 * Client-side DOM construction with signal bindings.
 *
 * This is the browser counterpart to the server renderer, and it is deliberately
 * the same shape: walk the VNode tree once and build nodes. There is still no
 * VDOM and no diffing (CLAUDE.md §6). Updates do not re-run the tree - they are
 * delivered by signal subscriptions attached to the exact text node or attribute
 * that depends on them, which is what makes a reactive engine unnecessary.
 */

import { Signal, effect } from "@preact/signals-core";
import { Fragment, isRaw, isVNode } from "../types.ts";
import type { Child, Props, VNode } from "../types.ts";

const EVENT_HANDLER = /^on[A-Z]/;

const ATTRIBUTE_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
};

/** Properties that must be assigned as DOM properties, not attributes. */
const DOM_PROPERTIES = new Set(["value", "checked", "selected", "indeterminate"]);

/** Teardown functions for the effects created while mounting a subtree. */
export type Disposer = () => void;

interface MountScope {
  disposers: Disposer[];
}

/** Render a VNode tree into a detached fragment, returning it and its teardown. */
export function mountTree(child: Child): { fragment: DocumentFragment; dispose: Disposer } {
  const scope: MountScope = { disposers: [] };
  const fragment = document.createDocumentFragment();
  mountChild(child, fragment, scope);
  return {
    fragment,
    dispose: () => {
      for (const dispose of scope.disposers) dispose();
      scope.disposers.length = 0;
    },
  };
}

function mountChild(child: Child, parent: Node, scope: MountScope): void {
  if (child == null || typeof child === "boolean") return;

  if (typeof child === "string" || typeof child === "number" || typeof child === "bigint") {
    parent.appendChild(document.createTextNode(String(child)));
    return;
  }

  if (isRaw(child)) {
    const template = document.createElement("template");
    template.innerHTML = child.value;
    parent.appendChild(template.content);
    return;
  }

  if (child instanceof Signal) {
    mountSignalChild(child, parent, scope);
    return;
  }

  if (Array.isArray(child)) {
    for (const item of child) mountChild(item, parent, scope);
    return;
  }

  if (isVNode(child)) {
    mountVNode(child, parent, scope);
    return;
  }

  throw new TypeError(`Cannot render value of type ${typeof child}.`);
}

/**
 * Bind a signal into the DOM.
 *
 * A trailing comment node anchors the position so the bound content can be
 * replaced in place even when it spans several nodes. Text-to-text updates take
 * a fast path that mutates the existing node rather than replacing it, which
 * keeps the common case (a counter, a label) allocation-free and preserves
 * selection and focus around it.
 */
function mountSignalChild(signal: Signal<unknown>, parent: Node, scope: MountScope): void {
  const anchor = document.createComment("");
  parent.appendChild(anchor);

  let mounted: Node[] = [];

  const dispose = effect(() => {
    const value = signal.value as Child;
    const container = anchor.parentNode;
    if (!container) return;

    if (mounted.length === 1 && mounted[0]!.nodeType === Node.TEXT_NODE && isTextLike(value)) {
      (mounted[0] as Text).data = String(value);
      return;
    }

    for (const node of mounted) (node as ChildNode).remove();

    const fragment = document.createDocumentFragment();
    mountChild(value, fragment, scope);
    mounted = Array.from(fragment.childNodes);
    container.insertBefore(fragment, anchor);
  });

  scope.disposers.push(dispose);
}

function isTextLike(value: unknown): value is string | number | bigint {
  const type = typeof value;
  return type === "string" || type === "number" || type === "bigint";
}

function mountVNode(vnode: VNode, parent: Node, scope: MountScope): void {
  const { type, props } = vnode;

  if (type === Fragment) {
    mountChild(props.children as Child, parent, scope);
    return;
  }

  if (typeof type === "function") {
    mountChild(type(props) as Child, parent, scope);
    return;
  }

  const element = document.createElement(type);

  for (const name in props) {
    if (name === "children" || name === "key" || name === "ref") continue;

    if (name === "dangerouslySetInnerHTML") {
      const html = (props[name] as { __html?: string } | undefined)?.__html;
      if (html != null) element.innerHTML = html;
      continue;
    }

    if (EVENT_HANDLER.test(name)) {
      const handler = props[name];
      if (typeof handler === "function") {
        element.addEventListener(name.slice(2).toLowerCase(), handler as EventListener);
      }
      continue;
    }

    bindAttribute(element, name, props[name], scope);
  }

  // `dangerouslySetInnerHTML` already populated the element.
  if (props.dangerouslySetInnerHTML == null) {
    mountChild(props.children as Child, element, scope);
  }

  parent.appendChild(element);
}

function bindAttribute(element: Element, name: string, value: unknown, scope: MountScope): void {
  if (value instanceof Signal) {
    const dispose = effect(() => setAttribute(element, name, value.value));
    scope.disposers.push(dispose);
    return;
  }
  setAttribute(element, name, value);
}

function setAttribute(element: Element, name: string, value: unknown): void {
  const attribute = ATTRIBUTE_ALIASES[name] ?? name;

  // Form state lives on the property, not the attribute - writing the attribute
  // would only change the *default* value and leave the live control untouched.
  if (DOM_PROPERTIES.has(attribute) && attribute in element) {
    (element as unknown as Record<string, unknown>)[attribute] = value ?? "";
    return;
  }

  // Styles go through the CSSOM rather than a style="" attribute. Under Sinter's
  // default CSP (`style-src 'self'`, no unsafe-inline) writing that attribute is
  // blocked, but CSSOM mutation is not governed by CSP at all - so a
  // signal-driven style works on a strict policy with no exception needed.
  if (attribute === "style") {
    applyStyle(element as HTMLElement, value);
    return;
  }

  if (value == null || value === false) {
    element.removeAttribute(attribute);
    return;
  }
  if (value === true) {
    element.setAttribute(attribute, "");
    return;
  }

  element.setAttribute(attribute, String(value));
}

function applyStyle(element: HTMLElement, value: unknown): void {
  const style = element.style;
  style.cssText = "";

  if (value == null || typeof value === "boolean") return;

  if (typeof value !== "object") {
    style.cssText = String(value);
    return;
  }

  for (const [property, raw] of Object.entries(value)) {
    if (raw == null || raw === false) continue;
    // Custom properties (--heat) are the main reason this path matters: they
    // let an island drive a stylesheet-defined effect without inline CSS.
    const name = property.startsWith("--")
      ? property
      : property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
    const unit = typeof raw === "number" && raw !== 0 && !UNITLESS_PROPERTIES.has(name) ? "px" : "";
    style.setProperty(name, `${raw}${unit}`);
  }
}

const UNITLESS_PROPERTIES = new Set([
  "opacity", "z-index", "flex", "flex-grow", "flex-shrink", "order",
  "line-height", "font-weight", "zoom", "grid-row", "grid-column",
]);
