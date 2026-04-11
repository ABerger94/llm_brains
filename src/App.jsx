import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ToastViewport } from './components/ui';
import AppLayout from './components/AppLayout';

import Dashboard from './pages/Dashboard';
import GraphPipelinePage from './pages/GraphPipelinePage';
import GraphPipelineRunsPage from './pages/GraphPipelineRunsPage';
import GraphPipelineScheduledTaskPage from './pages/GraphPipelineScheduledTaskPage';
import GraphPipelineLegacyRunRedirect from './pages/GraphPipelineLegacyRunRedirect';
import DialogueTranscriptIndexPage from './pages/DialogueTranscriptIndexPage';
import DialogueTranscriptSessionPage from './pages/DialogueTranscriptSessionPage';
import DialogueCuriosityDetailPage from './pages/DialogueCuriosityDetailPage';
import DialogueCuriosityThreadPage from './pages/DialogueCuriosityThreadPage';
import DialogueGoalDetailPage from './pages/DialogueGoalDetailPage';
import DialogueGoalThreadPage from './pages/DialogueGoalThreadPage';
import MindSelfPage from './pages/MindSelfPage';
import PersonalityProfilePage from './pages/PersonalityProfilePage';
import BeliefMapPage from './pages/BeliefMapPage';
import PipelineOutputSearchPage from './pages/PipelineOutputSearchPage';
import MultiMindRedirectPage from './pages/MultiMindRedirectPage';
import DmnReflectionsPage from './pages/DmnReflectionsPage';
import LiveAnalyticsPage from './pages/LiveAnalyticsPage';
import { GoalStackPage } from './pages/GoalStackPage';
import NeuralNetworkPage from './pages/NeuralNetworkPage';
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
      <Routes>
        <Route path="/consciousness-stream" element={<Navigate to="/graph-pipeline" replace />} />

        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />

          <Route path="/dialogue/curiosity/:curiosityId/thread" element={<DialogueCuriosityThreadPage />} />
          <Route path="/dialogue/curiosity/:curiosityId" element={<DialogueCuriosityDetailPage />} />
          <Route path="/dialogue/goal/:goalId/thread" element={<DialogueGoalThreadPage />} />
          <Route path="/dialogue/goal/:goalId" element={<DialogueGoalDetailPage />} />
          <Route path="/dialogue/:sessionId" element={<DialogueTranscriptSessionPage />} />
          <Route path="/dialogue" element={<DialogueTranscriptIndexPage />} />

          <Route path="/graph-pipeline/scheduled/:taskId" element={<GraphPipelineScheduledTaskPage />} />
          <Route path="/graph-pipeline/run/:sessionId" element={<GraphPipelineLegacyRunRedirect />} />
          <Route path="/graph-pipeline/:sessionId" element={<GraphPipelinePage />} />
          <Route path="/graph-pipeline" element={<GraphPipelineRunsPage />} />
          <Route path="/biography" element={<MindBiographyPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="/mind-self" element={<MindSelfPage />} />
          <Route path="/dmn-reflections" element={<DmnReflectionsPage />} />
          <Route path="/personality" element={<PersonalityProfilePage />} />
          <Route path="/beliefs" element={<BeliefMapPage />} />
          <Route path="/curiosity" element={<CuriosityPage />} />
          <Route path="/goals" element={<GoalStackPage />} />
          <Route path="/temporal" element={<TemporalPage />} />
          <Route path="/world-model" element={<WorldModelPage />} />
          <Route path="/shared-memory" element={<SharedMemoryPage />} />
          <Route path="/memory" element={<LongTermMemoryPage />} />
          <Route path="/dreaming" element={<DreamingPage />} />
          <Route path="/emergence" element={<EmergencePage />} />
          <Route path="/output-search" element={<PipelineOutputSearchPage />} />
          <Route path="/live-analytics" element={<LiveAnalyticsPage />} />
          <Route path="/iterations" element={<IterationsPage />} />
          <Route path="/experiments" element={<ExperimentsPage />} />
          <Route path="/rlhf" element={<RLHFPage />} />
          <Route path="/datasets" element={<DatasetPage />} />
          <Route path="/training" element={<TrainingPage />} />
          <Route path="/playground" element={<Playground />} />
          <Route path="/scheduler" element={<SchedulerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/user-manual" element={<UserManualPage />} />
          <Route path="/neural-network" element={<NeuralNetworkPage />} />

          <Route path="/multi-mind" element={<MultiMindRedirectPage />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <ToastViewport />
    </Router>
  );
}
