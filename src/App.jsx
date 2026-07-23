import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ToastViewport } from './components/ui';
import AppLayout from './components/AppLayout';

import Dashboard from './pages/Dashboard';
import GraphPipelinePage from './pages/GraphPipelinePage';
import GraphPipelineRunsPage from './pages/GraphPipelineRunsPage';
import GraphPipelineScheduledTaskPage from './pages/GraphPipelineScheduledTaskPage';
import GraphPipelineLegacyRunRedirect from './pages/GraphPipelineLegacyRunRedirect';
import MindSelfPage from './pages/MindSelfPage';
import VoiceOutputsPage from './pages/VoiceOutputsPage';
import PersonalityProfilePage from './pages/PersonalityProfilePage';
import BeliefMapPage from './pages/BeliefMapPage';
import PipelineOutputSearchPage from './pages/PipelineOutputSearchPage';
import MultiMindRedirectPage from './pages/MultiMindRedirectPage';
import DmnReflectionsPage from './pages/DmnReflectionsPage';
import LiveAnalyticsPage from './pages/LiveAnalyticsPage';
import { GoalStackPage } from './pages/GoalStackPage';
import NeuralNetworkPage from './pages/NeuralNetworkPage';
import BrowserMindPage from './pages/BrowserMindPage';
import Playground from './components/Playground';

import {
  LongTermMemoryPage,
  MindBiographyPage,
  WorldModelPage,
  CuriosityPage,
  TemporalPage,
  HealthPage,
  EmergencePage,
  DatasetPage,
  DreamingPage,
  RLHFPage,
  TrainingPage,
  SettingsPage,
} from './pages/LocalMindPages';
import {
  SharedMemoryPage,
  IterationsPage,
  ExperimentsPage,
  UserManualPage,
  SchedulerPage,
} from './pages/ExtraPages';

export default function App() {
  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <div className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
        <Routes>
          <Route path="/consciousness-stream" element={<Navigate to="/graph-pipeline" replace />} />

          <Route path="/dialogue" element={<Navigate to="/voice" replace />} />
          <Route path="/dialogue/" element={<Navigate to="/voice" replace />} />
          <Route path="/dialogue/mirror" element={<Navigate to="/voice/mirror" replace />} />
          <Route path="/dialogue/mirror/" element={<Navigate to="/voice/mirror" replace />} />

          {/** Trailing slashes → canonical paths */}
          <Route path="/voice/" element={<Navigate to="/voice" replace />} />
          <Route path="/voice/mirror/" element={<Navigate to="/voice/mirror" replace />} />

          {/**
           * Voice: two layout routes, each with only an index child — avoids pathless-layout + absolute path matching issues
           * (entire Voice missing) and avoids a single `/voice` parent whose `mirror` child can fail to render in &lt;Outlet /&gt;.
           */}
          <Route path="/voice/mirror" element={<AppLayout />}>
            <Route index element={<VoiceOutputsPage />} />
          </Route>
          <Route path="/voice" element={<AppLayout />}>
            <Route index element={<VoiceOutputsPage />} />
          </Route>

          {/**
           * Graph pipeline: nested under a real `/graph-pipeline` segment (same pattern as `/voice`) so
           * AppLayout’s &lt;Outlet /&gt; always receives a child in production; avoids blank mobile views.
           */}
          <Route path="/graph-pipeline" element={<AppLayout />}>
            <Route index element={<GraphPipelineRunsPage />} />
            <Route path="mirror/:sessionId" element={<GraphPipelinePage />} />
            <Route path="mirror" element={<GraphPipelineRunsPage />} />
            <Route path="scheduled/:taskId" element={<GraphPipelineScheduledTaskPage />} />
            <Route path="run/:sessionId" element={<GraphPipelineLegacyRunRedirect />} />
            <Route path=":sessionId" element={<GraphPipelinePage />} />
          </Route>
          <Route path="/graph-pipeline/" element={<Navigate to="/graph-pipeline" replace />} />
          <Route path="/graph-pipeline/mirror/" element={<Navigate to="/graph-pipeline/mirror" replace />} />

          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />

            <Route path="/pending-mind-updates/mirror" element={<Navigate to="/beliefs/mirror" replace />} />
            <Route path="/pending-mind-updates" element={<Navigate to="/beliefs" replace />} />
            <Route path="/beliefs/mirror" element={<BeliefMapPage />} />
            <Route path="/beliefs" element={<BeliefMapPage />} />
            <Route path="/memory/mirror" element={<LongTermMemoryPage />} />
            <Route path="/memory" element={<LongTermMemoryPage />} />
            <Route path="/curiosity/mirror" element={<CuriosityPage />} />
            <Route path="/curiosity" element={<CuriosityPage />} />
            <Route path="/goals/mirror" element={<GoalStackPage />} />
            <Route path="/goals" element={<GoalStackPage />} />
            <Route path="/biography/mirror" element={<MindBiographyPage />} />
            <Route path="/biography" element={<MindBiographyPage />} />
            <Route path="/world-model/mirror" element={<WorldModelPage />} />
            <Route path="/world-model" element={<WorldModelPage />} />
            <Route path="/temporal/mirror" element={<TemporalPage />} />
            <Route path="/temporal" element={<TemporalPage />} />
            <Route path="/emergence/mirror" element={<EmergencePage />} />
            <Route path="/emergence" element={<EmergencePage />} />
            <Route path="/shared-memory/mirror" element={<SharedMemoryPage />} />
            <Route path="/shared-memory" element={<SharedMemoryPage />} />
            <Route path="/iterations/mirror" element={<IterationsPage />} />
            <Route path="/iterations" element={<IterationsPage />} />
            <Route path="/output-search/mirror" element={<PipelineOutputSearchPage />} />
            <Route path="/output-search" element={<PipelineOutputSearchPage />} />

            <Route path="/health/mirror" element={<HealthPage />} />
            <Route path="/health" element={<HealthPage />} />
            <Route path="/mind-self/mirror" element={<MindSelfPage />} />
            <Route path="/mind-self" element={<MindSelfPage />} />
            <Route path="/dmn-reflections/mirror" element={<DmnReflectionsPage />} />
            <Route path="/dmn-reflections" element={<DmnReflectionsPage />} />
            <Route path="/personality/mirror" element={<PersonalityProfilePage />} />
            <Route path="/personality" element={<PersonalityProfilePage />} />
            <Route path="/dreaming/mirror" element={<DreamingPage />} />
            <Route path="/dreaming" element={<DreamingPage />} />
            <Route path="/live-analytics" element={<LiveAnalyticsPage />} />
            <Route path="/experiments" element={<ExperimentsPage />} />
            <Route path="/rlhf" element={<RLHFPage />} />
            <Route path="/datasets" element={<DatasetPage />} />
            <Route path="/training" element={<TrainingPage />} />

            <Route path="/playground/mirror/beliefs" element={<Navigate to="/beliefs/mirror" replace />} />
            <Route path="/playground/mirror/memory" element={<Navigate to="/memory/mirror" replace />} />
            <Route path="/playground/mirror" element={<Navigate to="/playground" replace />} />
            <Route path="/playground" element={<Playground />} />
            <Route path="/scheduler/mirror" element={<SchedulerPage />} />
            <Route path="/scheduler" element={<SchedulerPage />} />
            <Route path="/settings/mirror" element={<SettingsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/user-manual" element={<UserManualPage />} />
            <Route path="/neural-network" element={<NeuralNetworkPage />} />

            <Route path="/multi-mind" element={<MultiMindRedirectPage />} />
            <Route path="/browser-mind" element={<BrowserMindPage />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
        <ToastViewport />
      </div>
    </Router>
  );
}
