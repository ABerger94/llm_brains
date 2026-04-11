import { Navigate, useParams } from 'react-router-dom';

/** Bookmarks from `/graph-pipeline/run/:sessionId` */
export default function GraphPipelineLegacyRunRedirect() {
  const { sessionId } = useParams();
  const id = String(sessionId || '').trim();
  if (!id) return <Navigate to="/graph-pipeline" replace />;
  return <Navigate to={`/graph-pipeline/${encodeURIComponent(id)}`} replace />;
}
