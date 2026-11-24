import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseFollowUp } from "./follow-up";
import Home from "../app/page";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("ScribeFlow could not find its page container.");
}

createRoot(root).render(
  <StrictMode>
    <Home parseFollowUp={parseFollowUp} />
  </StrictMode>,
);
