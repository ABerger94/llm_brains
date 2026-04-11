import { useState, useRef, useEffect } from "react";
import {
  COGNITIVE_MODULES,
  COGNITIVE_MODULES_PIPELINE_ORDER,
  compareModuleIdsByPipelineOrder,
} from "../lib/cognitiveModules";
import { invokeLLM } from "../lib/llm";
import { Send, Save, ThumbsUp, ThumbsDown, Loader2, Settings2, Columns, Brain } from "lucide-react";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";

export default function Playground() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [sideBySide, setSideBySide] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({ temperature: 0.7, top_p: 0.9, max_tokens: 1024 });
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || isProcessing) return;
    const userMsg = { role: "user", content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsProcessing(true);

    // Run through cognitive pipeline
    const capturedInput = input;
    let prevOutputs = {};
    const moduleResults = {};

    for (const mod of COGNITIVE_MODULES_PIPELINE_ORDER) {
      let context = `USER INPUT: ${capturedInput}\n\n`;
      if (Object.keys(prevOutputs).length > 0) {
        context += "PREVIOUS MODULE OUTPUTS:\n";
        Object.entries(prevOutputs)
          .sort(([a], [b]) => compareModuleIdsByPipelineOrder(a, b))
          .forEach(([k, v]) => {
            const m = COGNITIVE_MODULES.find((cm) => cm.id === k);
            context += `[${m?.name}]: ${v}\n\n`;
          });
      }
      const prompt = `${mod.systemPrompt}\n\n${context}`;
      try {
        const result = await invokeLLM({ prompt, response_json_schema: { type: "object", properties: { output: { type: "string" } } } });
        const output = result.output || "No output";
        moduleResults[mod.id] = output;
        prevOutputs[mod.id] = output;
      } catch (error) {
        console.error(`Error in ${mod.name}:`, error);
        moduleResults[mod.id] = "Error processing";
        prevOutputs[mod.id] = "Error processing";
      }
    }

    const assistantMsg = {
      role: "assistant",
      content: moduleResults.reasoning || moduleResults.language || "No output generated.",
      moduleOutputs: moduleResults,
    };
    setMessages(prev => [...prev, assistantMsg]);

    if (sideBySide) {
      // Also get a "base" response
      try {
        const baseResult = await invokeLLM({ prompt: capturedInput, response_json_schema: { type: "object", properties: { output: { type: "string" } } } });
        const baseMsg = { role: "base", content: baseResult.output || "No output" };
        setMessages(prev => [...prev, baseMsg]);
      } catch (error) {
        const baseMsg = { role: "base", content: "Error generating base response" };
        setMessages(prev => [...prev, baseMsg]);
      }
    }

    setIsProcessing(false);
  };

  const saveAsTrainingData = async () => {
    // Mock save - in real app, would save to local storage or server
    alert("Training data saved locally (mock)");
  };

  const rateModule = (msgIdx, moduleId, rating) => {
    // Ratings UI is kept, persistence will be added in the training section.
    console.log('module rating', { msgIdx, moduleId, rating });
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-4 sm:px-6">
        <div>
          <h1 className="text-lg font-bold text-foreground">Model Playground</h1>
          <p className="text-xs text-muted-foreground">Interact with the full 7-module cognitive mind</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSideBySide(!sideBySide)} className={cn("gap-2", sideBySide && "border-primary text-primary")}>
            <Columns className="w-3 h-3" /> {sideBySide ? "Side-by-Side On" : "Side-by-Side"}
          </Button>
          <Button variant="outline" size="sm" onClick={saveAsTrainingData} className="gap-2">
            <Save className="w-3 h-3" /> Save as Dataset
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setShowSettings(!showSettings)}>
            <Settings2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex-1 flex flex-col">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <Brain className="w-12 h-12 text-muted-foreground/20 mb-3" />
                <h3 className="text-sm font-medium text-foreground">The Mind Awaits</h3>
                <p className="text-xs text-muted-foreground mt-1 max-w-sm">
                  Enter a thought, question, or scenario. It will be processed through all 7 cognitive modules, producing a rich, multi-dimensional response.
                </p>
              </div>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={cn("flex gap-3", msg.role === "user" ? "justify-end" : "justify-start")}>
                {msg.role !== "user" && (
                  <div className={cn(
                    "w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-1",
                    msg.role === "base" ? "bg-muted" : "bg-primary/10"
                  )}>
                    {msg.role === "base" ? "🤖" : <Brain className="w-3.5 h-3.5 text-primary" />}
                  </div>
                )}
                <div className={cn("max-w-[75%] space-y-2", msg.role === "user" && "flex flex-col items-end")}>
                  {msg.role === "base" && <span className="text-[10px] text-muted-foreground">Base GPT-4</span>}
                  {msg.role === "assistant" && <span className="text-[10px] text-primary">Cognitive Mind</span>}
                  <div className={cn(
                    "rounded-lg px-3 py-2 text-sm",
                    msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"
                  )}>
                    {msg.content}
                  </div>
                  {msg.moduleOutputs && (
                    <div className="space-y-1">
                      {Object.entries(msg.moduleOutputs)
                        .sort(([a], [b]) => compareModuleIdsByPipelineOrder(a, b))
                        .map(([modId, output]) => {
                        const mod = COGNITIVE_MODULES.find((m) => m.id === modId);
                        return (
                          <div key={modId} className="flex items-start gap-2 text-xs">
                            <span className="text-muted-foreground shrink-0 w-16">{mod?.name}:</span>
                            <span className="flex-1">{output}</span>
                            <div className="flex gap-1">
                              <button onClick={() => rateModule(idx, modId, 'up')} className="text-muted-foreground hover:text-green-500">
                                <ThumbsUp className="w-3 h-3" />
                              </button>
                              <button onClick={() => rateModule(idx, modId, 'down')} className="text-muted-foreground hover:text-red-500">
                                <ThumbsDown className="w-3 h-3" />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {isProcessing && (
              <div className="flex gap-3 justify-start">
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-1">
                  <Brain className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="max-w-[75%]">
                  <div className="rounded-lg px-3 py-2 bg-muted text-sm">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Processing through cognitive modules...
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-border p-4 sm:p-6">
            <div className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Enter your thought..."
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                disabled={isProcessing}
                className="flex-1 px-3 py-2 border border-border rounded-md text-sm"
              />
              <Button onClick={sendMessage} disabled={isProcessing || !input.trim()} size="icon">
                {isProcessing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              </Button>
            </div>
          </div>
        </div>

        {/* Settings panel */}
        {showSettings && (
          <div className="w-64 border-l border-border p-4 space-y-4">
            <h3 className="font-medium text-sm">Settings</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs block">Temperature: {settings.temperature}</label>
                <input
                  type="range"
                  value={settings.temperature}
                  onChange={(e) => setSettings(prev => ({ ...prev, temperature: parseFloat(e.target.value) }))}
                  min={0}
                  max={2}
                  step={0.1}
                  className="w-full mt-1"
                />
              </div>
              <div>
                <label className="text-xs block">Top P: {settings.top_p}</label>
                <input
                  type="range"
                  value={settings.top_p}
                  onChange={(e) => setSettings(prev => ({ ...prev, top_p: parseFloat(e.target.value) }))}
                  min={0}
                  max={1}
                  step={0.1}
                  className="w-full mt-1"
                />
              </div>
              <div>
                <label className="text-xs block">Max Tokens: {settings.max_tokens}</label>
                <input
                  type="range"
                  value={settings.max_tokens}
                  onChange={(e) => setSettings(prev => ({ ...prev, max_tokens: parseInt(e.target.value) }))}
                  min={100}
                  max={4096}
                  step={100}
                  className="w-full mt-1"
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}