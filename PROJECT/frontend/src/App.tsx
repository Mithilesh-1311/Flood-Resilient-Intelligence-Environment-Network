import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import Overview from "@/pages/Overview";
import Network from "@/pages/Network";
import FloodAI from "@/pages/FloodAI";
import Sensors from "@/pages/Sensors";
import Routing from "@/pages/Routing";
import NodeHealth from "@/pages/NodeHealth";
import Analytics from "@/pages/Analytics";

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="/network" element={<Network />} />
        <Route path="/flood-ai" element={<FloodAI />} />
        <Route path="/sensors" element={<Sensors />} />
        <Route path="/routing" element={<Routing />} />
        <Route path="/health" element={<NodeHealth />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
