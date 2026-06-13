import { Buffer } from "buffer";
import { createRoot } from "react-dom/client";
import App from "./App";

// venice-x402-client (ethers/siwe) relies on a global Buffer/process in the browser.
(globalThis as any).Buffer = (globalThis as any).Buffer || Buffer;
(globalThis as any).process = (globalThis as any).process || { env: {} };

createRoot(document.getElementById("root")!).render(<App />);
