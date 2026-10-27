import {
	DefaultContextMenu,
	DefaultContextMenuContent,
	TLComponents,
	TLUiContextMenuProps,
	TLUiOverrides,
	Tldraw,
	TldrawUiMenuActionItem,
	TldrawUiMenuGroup,
} from 'tldraw'
import 'tldraw/tldraw.css'
import { convertDrawingsToShapes, getConvertibleStrokes } from './convertDrawings'

// There's a guide at the bottom of this file!

const CONVERT_TO_SHAPES = 'convert-to-shapes'

// [1]
const overrides: TLUiOverrides = {
	actions(editor, actions, helpers) {
		return {
			...actions,
			[CONVERT_TO_SHAPES]: {
				id: CONVERT_TO_SHAPES,
				label: 'Convert to shapes',
				kbd: 'shift+s',
				// [2]
				isEnabled: () => editor.isIn('select.idle') && getConvertibleStrokes(editor).length > 0,
				onSelect() {
					const { converted, total } = convertDrawingsToShapes(editor)
					if (converted < total) {
						helpers.addToast({
							id: CONVERT_TO_SHAPES,
							title: `Converted ${converted} of ${total} drawing${total === 1 ? '' : 's'}`,
						})
					}
				},
			},
		}
	},
}

// [3]
function ContextMenu(props: TLUiContextMenuProps) {
	return (
		<DefaultContextMenu {...props}>
			<TldrawUiMenuGroup id={CONVERT_TO_SHAPES}>
				<TldrawUiMenuActionItem actionId={CONVERT_TO_SHAPES} />
			</TldrawUiMenuGroup>
			<DefaultContextMenuContent />
		</DefaultContextMenu>
	)
}

const components: TLComponents = { ContextMenu }

export default function SnapDrawingsToShapesExample() {
	return (
		<div className="tldraw__editor">
			<Tldraw overrides={overrides} components={components} />
		</div>
	)
}

/*
Sketch with the draw tool, select some strokes and press shift+S (or right-click and choose
"Convert to shapes"). The recognizer in `recognizeStroke.ts` decides what each stroke looks like,
and `convertDrawings.ts` replaces the ones it recognizes with geo shapes, lines and arrows.

[1]
The action is added through the `overrides` prop, like any of tldraw's own actions. That gives it
a keyboard shortcut and lets menus render it by id.

[2]
`isEnabled` gates the shortcut, the context menu item and `useActions()` in one place. Switching
to the draw tool doesn't clear the selection, so without the `select.idle` check pressing shift+S
mid-sketch would convert strokes that were selected earlier but are no longer highlighted.

[3]
`TldrawUiMenuActionItem` hides itself in the context menu while its action is disabled, so the item
only shows up when the selection contains drawings.
*/
