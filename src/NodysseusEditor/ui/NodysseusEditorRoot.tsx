/* eslint-disable @typescript-eslint/no-non-null-assertion */
import React, { useState, useEffect, useRef, useMemo } from "react";

import { isValidFilePath } from "../../Terminal/DirectoryHelpers";
import { IPlayer } from "../../PersonObjects/IPlayer";
import { IRouter } from "../../ui/Router";
import { dialogBoxCreate } from "../../ui/React/DialogBox";
import { isScriptFilename } from "../../Script/isScriptFilename";
import { Script } from "../../Script/Script";
import { TextFile } from "../../TextFile";
import { calculateRamUsage, checkInfiniteLoop } from "../../Script/RamCalculations";
import { RamCalculationErrorCode } from "../../Script/RamCalculationErrorCodes";
import { numeralWrapper } from "../../ui/numeralFormat";
import { DragDropContext, Droppable, Draggable } from "react-beautiful-dnd";

import { NetscriptFunctions } from "../../NetscriptFunctions";
import { WorkerScript } from "../../Netscript/WorkerScript";
import { Settings } from "../../Settings/Settings";
import { iTutorialNextStep, ITutorial, iTutorialSteps } from "../../InteractiveTutorial";
import { debounce } from "lodash";
import { saveObject } from "../../SaveObject";
import { GetServer } from "../../Server/AllServers";

import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import Link from "@mui/material/Link";
import Box from "@mui/material/Box";
import SettingsIcon from "@mui/icons-material/Settings";
import SyncIcon from '@mui/icons-material/Sync';
import CloseIcon from '@mui/icons-material/Close';
import Table from "@mui/material/Table";
import TableCell from "@mui/material/TableCell";
import TableRow from "@mui/material/TableRow";
import TableBody from "@mui/material/TableBody";
import { PromptEvent } from "../../ui/React/PromptManager";
import { Modal } from "../../ui/React/Modal";

import libSource from "!!raw-loader!../NetscriptDefinitions.d.ts";
import { Tooltip } from "@mui/material";

import {nodysseus} from "nodysseus";

interface IProps {
  // Map of filename -> code
  files: Record<string, string>;
  hostname: string;
  player: IPlayer;
  router: IRouter;
  vim: boolean;
}

// TODO: try to removve global symbols
let symbolsLoaded = false;
let symbols: string[] = [];
export function SetupTextEditor(): void {
  const ns = NetscriptFunctions({} as WorkerScript);

  // Populates symbols for text editor
  function populate(ns: any): string[] {
    let symbols: string[] = [];
    const keys = Object.keys(ns);
    for (const key of keys) {
      if (typeof ns[key] === "object") {
        symbols.push(key);
        symbols = symbols.concat(populate(ns[key]));
      }
      if (typeof ns[key] === "function") {
        symbols.push(key);
      }
    }

    return symbols;
  }

  symbols = populate(ns);

  const exclude = ["heart", "break", "exploit", "bypass", "corporation", "alterReality"];
  symbols = symbols.filter((symbol: string) => !exclude.includes(symbol)).sort();
}

// Holds all the data for a open script
class OpenScript {
  fileName: string;
  code: string;
  hostname: string;
  graph: any;

  constructor(fileName: string, code: string, hostname: string, graph: any) {
    this.fileName = fileName;
    this.code = code;
    this.hostname = hostname;
    this.graph = graph;
  }
}

let openScripts: OpenScript[] = [];
let currentScript: OpenScript | null = null;

// Called every time script editor is opened
export function Root(props: IProps): React.ReactElement {

  const nodysseusEl = useRef<HTMLElement>(null);


  const setRerender = useState(false)[1];
  function rerender(): void {
    setRerender((o) => !o);
  }
  const [editor, setEditor] = useState< | null>(null);

  const [ram, setRAM] = useState("RAM: ???");
  const [ramEntries, setRamEntries] = useState<string[][]>([["???", ""]]);
  const [updatingRam, setUpdatingRam] = useState(false);
  const [decorations, setDecorations] = useState<string[]>([]);

  const [ramInfoOpen, setRamInfoOpen] = useState(false);

  const nsNodes = [];

  // Prevent Crash if script is open on deleted server
  openScripts = openScripts.filter((script) => {
    return GetServer(script.hostname) !== null;
  })
  if (currentScript && (GetServer(currentScript.hostname) === null)) {
    currentScript = openScripts[0];
    if (currentScript === undefined) currentScript = null;
  }

  const [dimensions, setDimensions] = useState({
    height: window.innerHeight,
    width: window.innerWidth,
  });
  useEffect(() => {
    const debouncedHandleResize = debounce(function handleResize() {
      setDimensions({
        height: window.innerHeight,
        width: window.innerWidth,
      });
    }, 250);

    window.addEventListener("resize", debouncedHandleResize);

    return () => {
      window.removeEventListener("resize", debouncedHandleResize);
    };
  }, []);

  useEffect(() => {
    if (currentScript !== null) {
      updateRAM(currentScript.code);
    }
  }, []);

  useEffect(() => {
    onMount();
  })

  useEffect(() => {
    function keydown(event: KeyboardEvent): void {
      if (Settings.DisableHotkeys) return;
      //Ctrl + b
      if (event.code == "KeyB" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        props.router.toTerminal();
      }

      // CTRL/CMD + S
      if (event.code == "KeyS" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  });

  // Nodysseus
  useEffect(() => {
    if(nodysseusEl.current) {
      console.log(currentScript);
      const graph = currentScript?.code.match(/(?<=graph = ).*(?=; \/\/end_graph)/g)?.[0];
      console.log(graph);
      const cleanup = nodysseus(nodysseusEl.current.id, graph ? JSON.parse(graph) : {
        in: "main/in", 
        out: "main/out", 
        id: "default_ns",
        nodes: [{id: "main/in"}, {id: "state", "ref": "state"}, {id: "main/out"}], 
        edges: [{from: "main/in", to: "main/out", as: "args", "type": "ref"}, {from: "state", "to": "main/out", "as": "state"}]
      });
      nodysseusEl.current.addEventListener("updategraph", ((e: CustomEvent<any>) => {
        const stringified = JSON.stringify(e.detail.graph);
        console.log(stringified);
        if(currentScript && currentScript.graph !== stringified) {
          currentScript.graph = stringified;
          currentScript.code = `
            let graph = ${currentScript.graph}; //end_graph
            export async function main(ns, runGraph){
              runGraph(graph, 'main/out', {ns});
            }
          `
          save();
        }
      }) as EventListener);

      return cleanup;
    }
  }, [])

  function regenerateModel(script: OpenScript): void {
    //TODO Nodysseus: generate nodes?
  }

  // Generates a new model for the script

  const debouncedSetRAM = useMemo(
    () =>
      debounce((s, e) => {
        setRAM(s);
        setRamEntries(e);
        setUpdatingRam(false);
      }, 300),
    [],
  );

  async function updateRAM(newCode: string): Promise<void> {
    if (currentScript != null && currentScript.fileName.endsWith(".txt")) {
      debouncedSetRAM("N/A", [["N/A", ""]]);
      return;
    }
    setUpdatingRam(true);
    const codeCopy = newCode + "";
    const ramUsage = await calculateRamUsage(props.player, codeCopy, props.player.getCurrentServer().scripts);
    if (ramUsage.cost > 0) {
      const entries = ramUsage.entries?.sort((a, b) => b.cost - a.cost) ?? [];
      const entriesDisp = [];
      for (const entry of entries) {
        entriesDisp.push([`${entry.name} (${entry.type})`, numeralWrapper.formatRAM(entry.cost)]);
      }

      debouncedSetRAM("RAM: " + numeralWrapper.formatRAM(ramUsage.cost), entriesDisp);
      return;
    }
    switch (ramUsage.cost) {
      case RamCalculationErrorCode.ImportError: {
        debouncedSetRAM("RAM: Import Error", [["Import Error", ""]]);
        break;
      }
      case RamCalculationErrorCode.URLImportError: {
        debouncedSetRAM("RAM: HTTP Import Error", [["HTTP Import Error", ""]]);
        break;
      }
      case RamCalculationErrorCode.SyntaxError:
      default: {
        debouncedSetRAM("RAM: Syntax Error", [["Syntax Error", ""]]);
        break;
      }
    }
    return new Promise<void>(() => undefined);
  }


  // How to load function definition in monaco
  // https://github.com/Microsoft/monaco-editor/issues/1415
  // https://microsoft.github.io/monaco-editor/api/modules/monaco.languages.html
  // https://www.npmjs.com/package/@monaco-editor/react#development-playground
  // https://microsoft.github.io/monaco-editor/playground.html#extending-language-services-custom-languages
  // https://github.com/threehams/typescript-error-guide/blob/master/stories/components/Editor.tsx#L11-L39
  // https://blog.checklyhq.com/customizing-monaco/
  // Before the editor is mounted
  function beforeMount(): void {
    if (symbolsLoaded) return;
    // Setup monaco auto completion
    symbolsLoaded = true;
    for (const symbol of symbols) {
      nsNodes.push({
      });
    }
  }

  // When the editor is mounted
  function onMount(): void {
    // Required when switching between site navigation (e.g. from Script Editor -> Terminal and back)
    // the `useEffect()` for vim mode is called before editor is mounted.
    setEditor(editor);


    if (!props.files && currentScript !== null) {
      // Open currentscript
      regenerateModel(currentScript);
      return;
    }
    if (props.files) {
      const files = Object.entries(props.files);

      if (!files.length) {
        return;
      }

      for (const [filename, code] of files) {
        // Check if file is already opened
        const openScript = openScripts.find(
          (script) => script.fileName === filename && script.hostname === props.hostname,
        );
        if (openScript) {
          // Script is already opened
          if (openScript.graph === undefined || openScript.graph === null) {
            regenerateModel(openScript);
          }

          currentScript = openScript;
          updateRAM(openScript.code);
        } else {
          // Open script
          const newScript = new OpenScript(
            filename,
            code,
            props.hostname,
            {}
          );
          openScripts.push(newScript);
          currentScript = { ...newScript };
          updateRAM(newScript.code);
        }
      }
    }
  }

  // When the code is updated within the editor
  function updateCode(newGraph?: any, newCode?: string): void {
    if (newCode === undefined) return;
    updateRAM(newCode);
    if (currentScript !== null) {
      currentScript = { ...currentScript, code: newCode, graph: newGraph};
      const curIndex = openScripts.findIndex(
        (script) =>
          currentScript !== null &&
          script.fileName === currentScript.fileName &&
          script.hostname === currentScript.hostname,
      );
      const newArr = [...openScripts];
      const tempScript = currentScript;
      tempScript.code = newCode;
      newArr[curIndex] = tempScript;
      openScripts = [...newArr];
    }
  }

  function saveScript(scriptToSave: OpenScript): void {
    const server = GetServer(scriptToSave.hostname);
    if (server === null) throw new Error("Server should not be null but it is.");
    if (isScriptFilename(scriptToSave.fileName)) {
      //If the current script already exists on the server, overwrite it
      for (let i = 0; i < server.scripts.length; i++) {
        if (scriptToSave.fileName == server.scripts[i].filename) {
          server.scripts[i].saveScript(
            props.player,
            scriptToSave.fileName,
            scriptToSave.code,
            props.player.currentServer,
            server.scripts,
          );
          if (Settings.SaveGameOnFileSave) saveObject.saveGame();
          props.router.toTerminal();
          return;
        }
      }

      //If the current script does NOT exist, create a new one
      const script = new Script();
      script.saveScript(
        props.player,
        scriptToSave.fileName,
        scriptToSave.code,
        props.player.currentServer,
        server.scripts,
      );
      server.scripts.push(script);
    } else if (scriptToSave.fileName.endsWith(".txt")) {
      for (let i = 0; i < server.textFiles.length; ++i) {
        if (server.textFiles[i].fn === scriptToSave.fileName) {
          server.textFiles[i].write(scriptToSave.code);
          if (Settings.SaveGameOnFileSave) saveObject.saveGame();
          props.router.toTerminal();
          return;
        }
      }
      const textFile = new TextFile(scriptToSave.fileName, scriptToSave.code);
      server.textFiles.push(textFile);
    } else {
      dialogBoxCreate("Invalid filename. Must be either a script (.script, .js, or .ns) or " + " or text file (.txt)");
      return;
    }

    if (Settings.SaveGameOnFileSave) saveObject.saveGame();
    props.router.toTerminal();
  }

  function save(): void {
    if (currentScript === null) {
      console.error("currentScript is null when it shouldn't be. Unable to save script");
      return;
    }
    // this is duplicate code with saving later.
    if (ITutorial.isRunning && ITutorial.currStep === iTutorialSteps.TerminalTypeScript) {
      //Make sure filename + code properly follow tutorial
      if (currentScript.fileName !== "n00dles.script") {
        dialogBoxCreate("Leave the script name as 'n00dles.script'!");
        return;
      }
      if (currentScript.code.replace(/\s/g, "").indexOf("while(true){hack('n00dles');}") == -1) {
        dialogBoxCreate("Please copy and paste the code from the tutorial!");
        return;
      }

      //Save the script
      saveScript(currentScript);

      iTutorialNextStep();

      return;
    }

    if (currentScript.fileName == "") {
      dialogBoxCreate("You must specify a filename!");
      return;
    }

    if (!isValidFilePath(currentScript.fileName)) {
      dialogBoxCreate(
        "Script filename can contain only alphanumerics, hyphens, and underscores, and must end with an extension.",
      );
      return;
    }

    const server = GetServer(currentScript.hostname);
    if (server === null) throw new Error("Server should not be null but it is.");
    if (isScriptFilename(currentScript.fileName)) {
      //If the current script already exists on the server, overwrite it
      for (let i = 0; i < server.scripts.length; i++) {
        if (currentScript.fileName == server.scripts[i].filename) {
          server.scripts[i].saveScript(
            props.player,
            currentScript.fileName,
            currentScript.code,
            props.player.currentServer,
            server.scripts,
          );
          if (Settings.SaveGameOnFileSave) saveObject.saveGame();
          return;
        }
      }

      //If the current script does NOT exist, create a new one
      const script = new Script();
      script.saveScript(
        props.player,
        currentScript.fileName,
        currentScript.code,
        props.player.currentServer,
        server.scripts,
      );
      server.scripts.push(script);
    } else if (currentScript.fileName.endsWith(".txt")) {
      for (let i = 0; i < server.textFiles.length; ++i) {
        if (server.textFiles[i].fn === currentScript.fileName) {
          server.textFiles[i].write(currentScript.code);
          if (Settings.SaveGameOnFileSave) saveObject.saveGame();
          return;
        }
      }
      const textFile = new TextFile(currentScript.fileName, currentScript.code);
      server.textFiles.push(textFile);
    } else {
      dialogBoxCreate("Invalid filename. Must be either a script (.script, .js, or .ns) or " + " or text file (.txt)");
      return;
    }

    if (Settings.SaveGameOnFileSave) saveObject.saveGame();
  }

  function reorder(list: Array<OpenScript>, startIndex: number, endIndex: number): OpenScript[] {
    const result = Array.from(list);
    const [removed] = result.splice(startIndex, 1);
    result.splice(endIndex, 0, removed);

    return result;
  }

  function onDragEnd(result: any): void {
    // Dropped outside of the list
    if (!result.destination) {
      result;
      return;
    }

    const items = reorder(openScripts, result.source.index, result.destination.index);

    openScripts = items;
  }

  function onTabClick(index: number): void {
    if (currentScript !== null) {
      // Save currentScript to openScripts
      const curIndex = openScripts.findIndex(
        (script) =>
          currentScript !== null &&
          script.fileName === currentScript.fileName &&
          script.hostname === currentScript.hostname,
      );
      openScripts[curIndex] = currentScript;
    }

    currentScript = { ...openScripts[index] };
  }

  function onTabClose(index: number): void {
    // See if the script on the server is up to date
    const closingScript = openScripts[index];
    const savedScriptIndex = openScripts.findIndex(
      (script) => script.fileName === closingScript.fileName && script.hostname === closingScript.hostname,
    );
    let savedScriptCode = "";
    if (savedScriptIndex !== -1) {
      savedScriptCode = openScripts[savedScriptIndex].code;
    }
    const server = GetServer(closingScript.hostname);
    if (server === null) throw new Error(`Server '${closingScript.hostname}' should not be null, but it is.`);

    const serverScriptIndex = server.scripts.findIndex((script) => script.filename === closingScript.fileName);
    if (serverScriptIndex === -1 || savedScriptCode !== server.scripts[serverScriptIndex as number].code) {
      PromptEvent.emit({
        txt: "Do you want to save changes to " + closingScript.fileName + "?",
        resolve: (result: boolean) => {
          if (result) {
            // Save changes
            closingScript.code = savedScriptCode;
            saveScript(closingScript);
          }
        },
      });
    }

    if (openScripts.length > 1) {
      openScripts = openScripts.filter((value, i) => i !== index);

      let indexOffset = -1;
      if (openScripts[index + indexOffset] === undefined) {
        indexOffset = 1;
        if (openScripts[index + indexOffset] === undefined) {
          indexOffset = 0;
        }
      }

      // Change current script if we closed it
      currentScript = openScripts[index + indexOffset];
      rerender();
    } else {
      // No more scripts are open
      openScripts = [];
      currentScript = null;
      props.router.toTerminal();
    }
  }

  function onTabUpdate(index: number): void {
    const openScript = openScripts[index];
    const serverScriptCode = getServerCode(index);
    if (serverScriptCode === null) return;

    if (openScript.code !== serverScriptCode) {
      PromptEvent.emit({
        txt: "Do you want to overwrite the current editor content with the contents of " +
          openScript.fileName + " on the server? This cannot be undone.",
        resolve: (result: boolean) => {
          if (result) {
            // Save changes
            openScript.code = serverScriptCode;

            // Switch to target tab
            onTabClick(index)

          }
        },
      });
    }
  }

  function dirty(index: number): string {
    const openScript = openScripts[index];
    const serverScriptCode = getServerCode(index);
    if (serverScriptCode === null) return " *";

    // The server code is stored with its starting & trailing whitespace removed
    const openScriptFormatted = Script.formatCode(openScript.code);
    return serverScriptCode !== openScriptFormatted ? " *" : "";
  }

  function getServerCode(index: number): string | null {
    const openScript = openScripts[index];
    const server = GetServer(openScript.hostname);
    if (server === null) throw new Error(`Server '${openScript.hostname}' should not be null, but it is.`);

    const serverScript = server.scripts.find((s) => s.filename === openScript.fileName);
    return serverScript?.code ?? null;
  }

  // Toolbars are roughly 112px:
  //  8px body margin top
  //  38.5px filename tabs
  //  5px padding for top of editor
  //  44px bottom tool bar + 16px margin
  //  + vim bar 34px
  const editorHeight = dimensions.height - (130);

  return (
    <>
      <div style={{ display: "block", height: "100%", width: "100%" }}>
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="tabs" direction="horizontal">
            {(provided, snapshot) => (
              <Box
                maxWidth="1640px"
                display="flex"
                flexDirection="row"
                alignItems="center"
                whiteSpace="nowrap"
                ref={provided.innerRef}
                {...provided.droppableProps}
                style={{
                  backgroundColor: snapshot.isDraggingOver
                    ? Settings.theme.backgroundsecondary
                    : Settings.theme.backgroundprimary,
                  overflowX: "scroll",
                }}
              >
                {openScripts.map(({ fileName, hostname }, index) => {
                  const iconButtonStyle = {
                    maxWidth: "25px",
                    minWidth: "25px",
                    minHeight: '38.5px',
                    maxHeight: '38.5px',
                    ...(currentScript?.fileName === openScripts[index].fileName ? {
                      background: Settings.theme.button,
                      borderColor: Settings.theme.button,
                      color: Settings.theme.primary
                    } : {
                      background: Settings.theme.backgroundsecondary,
                      borderColor: Settings.theme.backgroundsecondary,
                      color: Settings.theme.secondary
                    })
                  };
                  return (
                    <Draggable
                      key={fileName + hostname}
                      draggableId={fileName + hostname}
                      index={index}
                      disableInteractiveElementBlocking={true}
                    >
                      {(provided) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.draggableProps}
                          {...provided.dragHandleProps}
                          style={{
                            ...provided.draggableProps.style,
                            marginRight: "5px",
                            flexShrink: 0,
                            border: '1px solid ' + Settings.theme.well,
                          }}
                        >
                          <Button
                            onClick={() => onTabClick(index)}
                            onMouseDown={e => {
                              e.preventDefault();
                              if (e.button === 1) onTabClose(index);
                            }}
                            style={{
                              ...(currentScript?.fileName === openScripts[index].fileName ? {
                                background: Settings.theme.button,
                                borderColor: Settings.theme.button,
                                color: Settings.theme.primary
                              } : {
                                background: Settings.theme.backgroundsecondary,
                                borderColor: Settings.theme.backgroundsecondary,
                                color: Settings.theme.secondary
                              })
                            }}
                          >
                            {hostname}:~/{fileName} {dirty(index)}
                          </Button>
                          <Tooltip title="Overwrite editor content with saved file content">
                            <Button onClick={() => onTabUpdate(index)} style={iconButtonStyle} >
                              <SyncIcon fontSize='small' />
                            </Button>
                          </Tooltip>
                          <Button onClick={() => onTabClose(index)} style={iconButtonStyle}>
                            <CloseIcon fontSize='small' />
                          </Button>
                        </div>
                      )}
                    </Draggable>
                  )
                })}
                {provided.placeholder}
              </Box>
            )}
          </Droppable>
        </DragDropContext>
        <div style={{ paddingBottom: "5px" }} />
        <div onChange={updateCode} />

        <Box
          className="nodysseus-editor"
          display="flex"
          flexDirection="row"
          sx={{ p: 1 }}
          alignItems="center"
          id="nodysseus-editor"
          style={{height: '100vh', width: '100%'}}
          ref={nodysseusEl}
        ></Box>

        <Box display="flex" flexDirection="row" sx={{ m: 1 }} alignItems="center">
          <Button color={updatingRam ? "secondary" : "primary"} sx={{ mx: 1 }} onClick={() => { setRamInfoOpen(true) }}>
            {ram}
          </Button>
          <Button onClick={save}>Save (Ctrl/Cmd + s)</Button>
          <Button onClick={props.router.toTerminal}>Close (Ctrl/Cmd + b)</Button>
          <Typography sx={{ mx: 1 }}>
            {" "}
            Documentation:{" "}
            <Link target="_blank" href="https://bitburner.readthedocs.io/en/latest/index.html">
              Basic
            </Link>{" "}
            |
            <Link target="_blank" href="https://github.com/danielyxie/bitburner/blob/dev/markdown/bitburner.ns.md">
              Full
            </Link>
          </Typography>
        </Box>
        <Modal open={ramInfoOpen} onClose={() => setRamInfoOpen(false)}>
          <Table>
            <TableBody>
              {ramEntries.map(([n, r]) => (
                <React.Fragment key={n + r}>
                  <TableRow>
                    <TableCell sx={{ color: Settings.theme.primary }}>{n}</TableCell>
                    <TableCell align="right" sx={{ color: Settings.theme.primary }}>{r}</TableCell>
                  </TableRow>
                </React.Fragment>
              ))}
            </TableBody>
          </Table>
        </Modal>
      </div>
    </>
  );
}
