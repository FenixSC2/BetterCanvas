import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { purgeLegacyStorage } from "./lib/storagePolicy";

purgeLegacyStorage();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
