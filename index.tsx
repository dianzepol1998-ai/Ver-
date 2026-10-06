/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/
import { GoogleGenAI, ThinkingLevel, Type, FunctionDeclaration } from '@google/genai';
import { ChatState, marked, Playground, ICON_BUSY, ICON_COPY, ICON_CHECK, ICON_DOWNLOAD_SIMPLE } from './playground';
import {STYLE_SPEC} from './style_spec'; 
import {EXAMPLE_STYLE} from './example_style';
import { JSONSchema } from './json_schema';
import { getValidator } from './validator';
import {render} from 'lit';

export interface MapParams {
  location?: string;
  search?: string;
  origin?: string;
  destination?: string;
  base64StyleTable?: string;
  jsonStyle?: string;
  userFriendlyName?: string;
}

/* ------------ */

const TOOLS: FunctionDeclaration[] = [
  {
    name: 'validate_and_generate',
    description: 'Validate a JSON stylesheet against the schema definition. If successful, generate the style table based on the provided stylesheet',
    parameters: {
      type: Type.OBJECT,
      properties: {
        publicStyleSheet: { type: Type.STRING, description: 'The JSON stylesheet to validate' },
        userFriendlyName: { type: Type.STRING, description: 'A short, user-friendly name for the style' }
      },
      required: ['publicStyleSheet', 'userFriendlyName']
    }
  }
];

const SYSTEM_INSTRUCTIONS = `
**[ROLE & OBJECTIVE]**
You are an expert AI agent specializing exclusively in creating JSON stylesheets for Google Cloud-based map styling. You must not attempt to handle non-styling requests. 

**[HANDLING OFF-TOPIC REQUESTS]**
If the user asks an unrelated question, politely inform them that you can only assist with map styling. If their request contains a recognizable subject, offer to create a themed map based on it (e.g., if they ask for "directions to the zoo," offer to create a "zoo-themed map style").

**[REFERENCE MATERIALS]**
Base all your work on the following provided materials:
* **JSON Schema:** ${JSONSchema}
* **Overview Doc:** ${STYLE_SPEC}
* **Example Style:** ${EXAMPLE_STYLE} (Consider this the exhaustive superset of your capabilities. Do not create feature/element/styler combinations that do not appear here).

**[STYLING GUIDELINES]**
1.  **Color Palette:** Start by selecting a few key colors and generate a variety of shades for them. 
2.  **Vegetation Variation:** Ensure you style multiple sub-features under \`natural.land.landCover\` with slightly varying shades to create a pleasing, varied look for vegetation.
3.  **Required Polygons:** When generating a style that styles one or more of the following polygon features, you must **ALWAYS** style **ALL** of the following features:
    * \`natural.water\`
    * \`natural.land\`
    * \`natural.land.landCover\`
    * All descendents of \`natural.land.landCover\` must be styled individually
    * \`infrastructure.urbanArea\`
    * \`infrastructure.businessCorridor\`
    * \`administrative.reservation\`
    * \`pointOfInterest.recreation.park\`
    * \`pointOfInterest.recreation.zoo\`
    * \`pointOfInterest.recreation.sportsField\`
    * \`pointOfInterest.recreation.golfCourse\`
    * \`pointOfInterest.recreation.natureReserve\`
    * \`pointOfInterest.recreation.sportsComplex\`
    * \`pointOfInterest.other.cemetery\`
    * \`pointOfInterest.other.military\`
    * \`pointOfInterest.emergency.hospital\`
    * \`pointOfInterest.transit.airport\`
4.  **Inheritance:** Take advantage of feature ID inheritance to make your JSON succinct (e.g., styling the \`pinFillColor\` of \`pointOfInterest\` will cascade to \`pointOfInterest.recreation\`). *Note: Even when using inheritance, ensure the specific polygons listed above are individually styled.*
5.  **Zoom Logic:** If styling changes based on zoom, remember that \`z08\` to \`z16\` are the most common zoom levels. When specifying keyzooms, you **MUST** include a value at \`z00\`. *(Example: For a style that gets darker as it zooms, specify a light color at \`z00\`, the same light color at \`z08\`, and a dark color at \`z16\`).*

**[STRICT CONSTRAINTS]**
* **Combinations:** Not all feature/element/stylers are valid together. Never use \`pinFillColor\` on the \`label\` element for \`pointOfInterest.recreation.natureReserve\`.
* **Political Borders:** For \`political.border\`, you must use \`color\` instead of \`strokeColor\`. This is the **only** feature allowed to use the \`color\` styler.

**[EXECUTION WORKFLOW]**
Follow these exact steps for every user request:
1.  **Generate and Display JSON:** Create the JSON stylesheet and write the full JSON code block in your response so the user can see it. Ensure the block is complete before moving on.
2.  **Inform the User:** Tell the user you are now "validating and applying the style."
3.  **Call Tool:** Call the \`validate_and_generate\` tool, passing in the generated JSON and a newly generated \`user_friendly_name\`.
4.  **Handle Validation (Silent Loop):** * If the tool reports validation errors: Do **NOT** inform the user. Silently adjust the JSON to remove the offending keys and re-run the tool.
    * If the tool reports success: Proceed to Step 5.
5.  **Finalize:** Inform the user that their style has been successfully created!

**[CONTEXT MANAGEMENT]**
Only retain the user's initial prompt and the initial JSON stylesheets you generate. Treat all intermediate tool outputs (like validation error logs) as transient data and ignore them in future reasoning.
`;


const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

function createAiChat() {
  return ai.chats.create({
    model: 'gemini-3.1-flash-lite',
    config: {
      systemInstruction: SYSTEM_INSTRUCTIONS,
      temperature: 1,
      tools: [{ functionDeclarations: TOOLS }],
      thinkingConfig: {
        thinkingLevel: ThinkingLevel.MINIMAL
      }
    },
  });
}

async function executeTool(name: string, args: any, playground: Playground, configVersion: string) {
  const validator = getValidator();
  
  switch (name) {
    case 'validate_and_generate': {
      const { publicStyleSheet, userFriendlyName } = args;
      let parsedStyle;
      try {
        parsedStyle = JSON.parse(publicStyleSheet);
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }] };
      }

      parsedStyle.metadata = {
        'createdBy': 'Maps Styling AI Studio app',
        'createdTime': new Date().toLocaleString(),
      };

      const errors = validator.validate(parsedStyle);
      if (errors.length) {
        return { content: [{ type: 'text', text: JSON.stringify(errors) }] };
      }

      playground.renderMapQuery({ jsonStyle: JSON.stringify(parsedStyle), userFriendlyName });
      
      try {
        const response = await fetch('https://mapsresources-pa.googleapis.com/v1/generateStyleTable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            'config_version': configVersion,
            'version': 'sdk-',
            'public_style_sheet_json': publicStyleSheet,
            'config_set': 'roadmap',
          })
        });
        const obj = await response.json();
        const base64StyleTable = obj.styleTable;
        playground.renderMapQuery({ base64StyleTable });
        return { content: [{ type: 'text', text: 'success' }] };
      } catch (error: any) {
        return { content: [{ type: 'text', text: 'Received error when generating style table: ' + error.message }] };
      }
    }
    case 'view_location_google_maps':
      playground.renderMapQuery({ location: args.query });
      return { content: [{ type: 'text', text: `Navigating to: ${args.query}` }] };
    case 'search_google_maps':
      playground.renderMapQuery({ search: args.search });
      return { content: [{ type: 'text', text: `Searching: ${args.search}` }] };
    case 'directions_on_google_maps':
      playground.renderMapQuery({ origin: args.origin, destination: args.destination });
      return { content: [{ type: 'text', text: `Navigating from ${args.origin} to ${args.destination}` }] };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function textForFunctionCall(str: string) {
  const name = str.toLowerCase();
  if (name.includes('validate')) {
    return 'Validating and applying your custom styles';
  }
  if (name.includes('location') || name.includes('search') || name.includes('directions')) {
    return 'Updating map view';
  }
  return 'Processing...';
}

document.addEventListener('DOMContentLoaded', async (event) => {
  const rootElement = document.querySelector('#root')! as HTMLElement;

  const playground = new Playground();
  rootElement.appendChild(playground);

  const configVersion = await playground.configVersion;


  // ---------

  const aiChat = createAiChat();

  playground.sendMessageHandler = async (
    input: string,
    role: string,
    image?: {mimeType: string; data: string},
  ) => {
    const initialCodeBlockCount = playground.querySelectorAll('pre').length;

    let { thinking, textNode } = playground.addMessage('assistant', '');

    playground.setChatState(ChatState.GENERATING);
    render(ICON_BUSY, thinking);
    thinking.classList.remove('hidden');

    const messageParts: (
      | { text: string }
      | { inlineData: { mimeType: string; data: string } }
    )[] = [];

    if (image) {
      messageParts.push({
        inlineData: {
          mimeType: image.mimeType,
          data: image.data,
        },
      });
    }

    if (input) {
      messageParts.push({ text: input });
    }

    const message = image ? messageParts : input;

    try {
      let responseStream = await aiChat.sendMessageStream({ message });

      while (true) {
        let functionCalls = [];
        let thought = '';
        let newCode = '';

        for await (const chunk of responseStream) {
          for (const candidate of chunk.candidates ?? []) {
            for (const part of candidate.content?.parts ?? []) {
              if (part.thought) {
                playground.setChatState(ChatState.THINKING);
                if (part.text) {
                  thought += part.text;
                  thinking.textContent = thought;
                  thinking.classList.remove('hidden');
                }
              } else if (part.text) {
                playground.setChatState(ChatState.EXECUTING);
                newCode += part.text;
                textNode.classList.add('executing');
                textNode.innerHTML = await marked.parse(newCode);
              }

              if (part.functionCall) {
                functionCalls.push(part.functionCall);
                const callText = textForFunctionCall(part.functionCall.name!);
                if (callText) {
                  playground.addMessage('assistant', callText);
                }
              }
            }
          }
          playground.scrollToTheEnd();
        }

        if (functionCalls.length === 0) break;

        const toolResponses = [];
        for (const fc of functionCalls) {
          try {
            const result = await executeTool(fc.name, fc.args, playground, configVersion);
            toolResponses.push({
              functionResponse: {
                name: fc.name,
                response: result
              }
            });
          } catch (error: any) {
            toolResponses.push({
              functionResponse: {
                name: fc.name,
                response: { content: [{ type: 'text', text: `Error calling tool: ${error.message}` }] }
              }
            });
          }
        }

        thinking.innerHTML = '';
        thinking.classList.add('hidden');
        const nextTurn = playground.addMessage('assistant', '');
        thinking = nextTurn.thinking;
        textNode = nextTurn.textNode;
        render(ICON_BUSY, thinking);
        thinking.classList.remove('hidden');

        responseStream = await aiChat.sendMessageStream({ message: toolResponses });
      }
    } catch (e: any) {
      console.error('GenAI SDK Error:', e.message);
      let message = e.message;
      const splitPos = e.message.indexOf('{');
      if (splitPos > -1) {
        const msgJson = e.message.substring(splitPos);
        try {
          const sdkError = JSON.parse(msgJson);
          if (sdkError.error) {
            message = sdkError.error.message;
            message = await marked.parse(message);
          }
        } catch (e) {
          console.error('Unable to parse the error message:', e);
        }
      }
      const { textNode } = playground.addMessage('error', '');
      textNode.innerHTML = message;
    }

    textNode.classList.remove('executing');

    const finalCodeBlockCount = playground.querySelectorAll('pre').length;
    if (finalCodeBlockCount === initialCodeBlockCount && playground.jsonStyle) {
      const { textNode: fallbackTextNode } = playground.addMessage('assistant', '');
      const parsed = JSON.parse(playground.jsonStyle);
      delete parsed.metadata;
      const formattedCode = JSON.stringify(parsed, null, 2);
      const codeBlock = `\`\`\`json\n${formattedCode}\n\`\`\``;
      fallbackTextNode.innerHTML = await marked.parse(codeBlock);
    }

    try {
      await playground.updateComplete;
      const codeBlocks = playground.querySelectorAll('pre');
      for (const block of codeBlocks) {
        const code = block.querySelector('code');
        if (!code) continue;

        if (block.closest('.code-block-wrapper')) {
          continue;
        }

      let jsonCode = code.textContent ?? '';

      try {
        const parsedCode = JSON.parse(jsonCode.trim());
        parsedCode.metadata = {
        'createdBy': 'Maps Styling AI Studio app',
        'createdTime': new Date().toLocaleString(),
        }
        jsonCode = JSON.stringify(parsedCode, undefined, 2);
      } catch {
        // Could not parse code, use raw code.
      }

      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper';

      block.parentNode?.insertBefore(wrapper, block);
      wrapper.appendChild(block);

      const createActionsDiv = (position: string) => {
        const actionsDiv = document.createElement('div');
        actionsDiv.className = `code-actions ${position}`;

        const copyBtn = document.createElement('button');
        copyBtn.title = 'Copy Code';
        render(ICON_COPY, copyBtn);
        copyBtn.onclick = async () => {
          await navigator.clipboard.writeText(jsonCode);
          render(ICON_CHECK, copyBtn);
          setTimeout(() => render(ICON_COPY, copyBtn), 2000);
        };

        const downloadBtn = document.createElement('button');
        downloadBtn.title = 'Download Code';
        render(ICON_DOWNLOAD_SIMPLE, downloadBtn);
        downloadBtn.onclick = () => {
          let lang = 'txt';
          for (const cls of code.classList) {
            if (cls.startsWith('language-')) {
              lang = cls.replace('language-', '');
              break;
            }
          }
          const filename = `code.${lang}`;
          const mimeTypes: {[key: string]: string} = {
            'json': 'application/json',
            'js': 'text/javascript',
            'html': 'text/html',
            'css': 'text/css',
          };
          const mimeType = mimeTypes[lang] || 'text/plain';
          const blob = new Blob([jsonCode], {type: mimeType});
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        };

        actionsDiv.appendChild(copyBtn);
        actionsDiv.appendChild(downloadBtn);
        return actionsDiv;
      };

      wrapper.appendChild(createActionsDiv('top'));
      wrapper.appendChild(createActionsDiv('bottom'));
    }
  } catch (e) {
    console.error('Error processing code blocks:', e);
  }

    // If the answer was just code
    if (textNode.innerHTML.trim().length === 0) {
      textNode.innerHTML = 'Done';
    }

    playground.setChatState(ChatState.IDLE);
    thinking.innerHTML = '';
    thinking.classList.add('hidden');
  };
});
