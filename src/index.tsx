import { render } from "solid-js/web";

import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@phosphor-icons/web/light";
import "./styles/app.css";

import App from "./App";

const root = document.getElementById("root");
render(() => <App />, root!);
