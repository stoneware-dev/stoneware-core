import { csrfToken } from "stoneware";

/** Personalized the framework's own way: it renders a token. */
export default function Contact() {
  return <main>{csrfToken()}</main>;
}
