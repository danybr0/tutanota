// @flow
import m from "mithril"
import {log, timer, Cat} from "../../misc/Log"
import {px} from "../size"
import {client} from "../../misc/ClientDetector"
import {GENERATED_MAX_ID, firstBiggerThanSecond, getLetId} from "../../api/common/EntityFunctions"
import {OperationType} from "../../api/common/TutanotaConstants"
import {last, remove, addAll, arrayEquals} from "../../api/common/utils/ArrayUtils"
import {neverNull} from "../../api/common/utils/Utils"
import {assertMainOrNode} from "../../api/Env"
import MessageBox from "./MessageBox"
import {progressIcon} from "./Icon"
import {animations, transform} from "./../animation/Animations"
import {ease} from "../animation/Easing"
import {DefaultAnimationTime, opacity} from "../animation/Animations"

assertMainOrNode()

export const ScrollBuffer = 15 // virtual elements that are used as scroll buffer in both directions
const PageSize = 100

/**
 * A list that renders only a few dom elements (virtual list) to represent the items of even very large lists. The
 * virtual list is rendered as svg background on mobile devices for providing a native scrolling experience.
 *
 * Generics:
 * * T is the type of the entity
 * * R is the type of the Row
 */
export class List<T, R:VirtualRow<T>> {
	_config: ListConfig<T, R>;
	_loadedEntities: T[]; // sorted with _config.sortCompare
	_virtualList: R[]; // displays a part of the page, VirtualRows map 1:1 to DOM-Elements
	_domListContainer: HTMLElement;
	_domList: HTMLElement;
	_domInitialized: Object;
	_width: number;
	_loadedCompletely: boolean;
	_loading: Promise<void>;

	currentPosition: number;
	lastPosition: number;
	lastUpdateTime: number;
	updateLater: boolean; // if set, paint operations are executed later, when the scroll speed becomes slower
	repositionTimeout: ?number; // the id of the timeout to reposition if updateLater == true and scrolling stops abruptly (e.g. end of list or user touch)
	_domStatus: {bufferUp: ?HTMLElement, bufferDown: ?HTMLElement, speed: ?HTMLElement, scrollDiff: ?HTMLElement, timeDiff: ?HTMLElement};

	_visibleElementsHeight: number;
	bufferHeight: number;

	_domSwipeSpacerLeft: HTMLElement;
	_domSwipeSpacerRight: HTMLElement;
	_domLoadingRow: HTMLElement;

	ready: boolean;
	view: Function;
	onbeforeupdate: Function;
	onremove: Function;

	_selectedEntities: T[]; // the selected entities must be sorted the same way the loaded entities are sorted
	_lastMultiSelectWasKeyUp: boolean; // true if the last key multi selection action was selecting the previous entity, false if it was selecting the next entity

	_idOfEntityToSelectWhenReceived: ?Id;

	_emptyMessageBox: MessageBox;

	constructor(config: ListConfig<T, R>) {
		this._config = config
		this._loadedEntities = []
		function createPromise() {
			let wrapper = {}
			wrapper.promise = new Promise.fromCallback(cb => {
				wrapper.resolve = cb
			})
			return wrapper
		}

		let reset = () => {
			this._domInitialized = createPromise()

			this.ready = false
			this._virtualList = []
		}

		reset()

		this._virtualList = []
		this._width = 0
		this._loadedCompletely = false
		this._loading = Promise.resolve();

		this.currentPosition = 0
		this.lastPosition = 0
		this.updateLater = false
		this._visibleElementsHeight = 0
		this.bufferHeight = this._config.rowHeight * ScrollBuffer

		this._domStatus = {bufferUp: null, bufferDown: null, speed: null, scrollDiff: null, timeDiff: null}

		this._selectedEntities = []
		this._lastMultiSelectWasKeyUp = false // value does not matter here

		this._idOfEntityToSelectWhenReceived = null

		this.onbeforeupdate = () => !this.ready // the list should never be redrawn by mithril after the inial draw

		this.onremove = reset

		this._emptyMessageBox = new MessageBox(() => this._config.emptyMessage, "list-message-bg")
			.setVisible(false)

		this.view = (vnode): VirtualElement => {
			let list = m(".list-container[tabindex=-1].fill-absolute.scroll.list-border-right.list-bg.nofocus.overflow-x-hidden", {
				oncreate: (vnode) => this._init(vnode.dom)
			}, [
				m(".swipe-spacer.flex.items-center.justify-end.pr-l.blue", {
					oncreate: (vnode) => this._domSwipeSpacerLeft = vnode.dom,
					style: {
						height: px(this._config.rowHeight),
						transform: `translateY(-${this._config.rowHeight}px)`,
						position: 'absolute',
						'z-index': 1,
						width: px(this._width),
					}
				}, this._config.swipe.renderLeftSpacer()),
				m(".swipe-spacer.flex.items-center.pl-l.red", {
					oncreate: (vnode) => this._domSwipeSpacerRight = vnode.dom,
					style: {
						height: px(this._config.rowHeight),
						transform: `translateY(-${this._config.rowHeight}px)`,
						position: 'absolute',
						'z-index': 1,
						width: px(this._width),
					}
				}, this._config.swipe.renderRightSpacer()),
				m("ul.list.fill-absolute.pointer", {
						oncreate: (vnode) => this._setDomList(vnode.dom),
						style: {height: this._calculateListHeight()},
						className: this._config.className
					},
					[
						this._virtualList.map(virtualRow => {
							return m("li.list-row.plr-l.pt.pb" + (this._config.elementsDraggable ? '[draggable="true"]' : ""), {
								oncreate: (vnode) => this._initRow(virtualRow, vnode.dom),
								style: {transform: `translateY(-${this._config.rowHeight}px)`},
								ondragstart: (event) => this._dragstart(event, virtualRow)
							}, virtualRow.render())
						}),
						// odd-row is switched directly on the dom element when the number of elements changes
						m("li.list-loading.list-row.flex-center.items-center.odd-row", {
							oncreate: (vnode) => this._domLoadingRow = vnode.dom,
							style: {display: this._loadedCompletely ? 'none' : null}
						}, progressIcon())

					]
				),
				m(this._emptyMessageBox)
			])
			if (this._config.showStatus) {

				return m(".status-wrapper", [
					m(".status.flex.justify-between.fill-absolute", {
						style: {
							height: px(60)
						}
					}, [
						m("div", [
							m(".bufferUp", {oncreate: (vnode) => this._domStatus.bufferUp = vnode.dom}),
							m(".bufferDown", {oncreate: (vnode) => this._domStatus.bufferDown = vnode.dom}),
						]),
						m("div", [
							m(".scrollDiff", {oncreate: (vnode) => this._domStatus.scrollDiff = vnode.dom}),
						]),
						m("div", [
							m(".speed", {oncreate: (vnode) => this._domStatus.speed = vnode.dom}),
							m(".time", {oncreate: (vnode) => this._domStatus.timeDiff = vnode.dom}),
						]),
					]),
					m(".list-wrapper.fill-absolute", {
						style: {
							top: px(60),
						}
					}, list),
				])
			} else {
				return list
			}
		}
	}

	_initRow(virtualRow: VirtualElement, domElement: HTMLElement) {
		virtualRow.domElement = domElement
		domElement.onclick = (e) => this._elementClicked(virtualRow.entity, e)
	}

	_dragstart(ev: DragEvent, virtualRow: VirtualRow<T>) {
		// unfortunately, IE only allowes "text" and "url"
		neverNull(ev.dataTransfer).setData("text", getLetId(virtualRow.entity)[1]);
	}

	getEntity(id: Id): ?T {
		return this._loadedEntities.find(entity => getLetId(entity)[1] == id)
	}


	/**
	 * Updates the given list of selected items with a click on the given clicked item. Takes ctrl and shift key events into consideration for multi selection.
	 * If ctrl is pressed the selection status of the clickedItem is toggled.
	 * If shift is pressed, all items beginning from the nearest selected item to the clicked item are additionally selected.
	 * If neither ctrl nor shift are pressed only the clicked item is selected.
	 */
	_elementClicked(clickedEntity: T, event: MouseEvent) {
		let mobileMultiSelectionActive = false //TODO set when mobile multi selection is implemented

		let selectionChanged = false
		let multiSelect = false
		if (this._config.multiSelectionAllowed && (mobileMultiSelectionActive || (client.isMacOS ? event.metaKey : event.ctrlKey))) {
			selectionChanged = true
			multiSelect = true
			if (this._selectedEntities.indexOf(clickedEntity) != -1) {
				remove(this._selectedEntities, clickedEntity)
			} else {
				this._selectedEntities.push(clickedEntity)
			}
		} else if (this._config.multiSelectionAllowed && event.shiftKey) {
			multiSelect = true
			if (this._selectedEntities.length == 0) {
				// no item is selected, so treat it as if shift was not pressed
				this._selectedEntities.push(clickedEntity)
				selectionChanged = true
			} else if (this._selectedEntities.length == 1 && this._selectedEntities[0] == clickedEntity) {
				// nothing to do, the item is already selected
			} else {
				// select all items from the given item to the nearest already selected item
				let clickedItemIndex: number = this._loadedEntities.indexOf(clickedEntity)
				let nearestSelectedIndex: ?number = null
				for (let i = 0; i < this._selectedEntities.length; i++) {
					let currentSelectedItemIndex = this._loadedEntities.indexOf(this._selectedEntities[i])
					if (nearestSelectedIndex == null || Math.abs(clickedItemIndex - currentSelectedItemIndex) < Math.abs(clickedItemIndex - nearestSelectedIndex)) {
						nearestSelectedIndex = currentSelectedItemIndex
					}
				}
				let itemsToAddToSelection = []
				if (neverNull(nearestSelectedIndex) < clickedItemIndex) {
					for (let i = neverNull(nearestSelectedIndex) + 1; i <= clickedItemIndex; i++) {
						itemsToAddToSelection.push(this._loadedEntities[i])
					}
				} else {
					for (let i = clickedItemIndex; i < neverNull(nearestSelectedIndex); i++) {
						itemsToAddToSelection.push(this._loadedEntities[i])
					}
				}
				addAll(this._selectedEntities, itemsToAddToSelection)
				selectionChanged = itemsToAddToSelection.length > 0
			}
		} else {
			if (!arrayEquals(this._selectedEntities, [clickedEntity])) {
				this._selectedEntities.splice(0, this._selectedEntities.length, clickedEntity)
				selectionChanged = true
			}
		}
		if (selectionChanged) {
			// the selected entities must be sorted the same way the loaded entities are sorted
			this._selectedEntities.sort(this._config.sortCompare)
			this._reposition()
		}
		this._config.elementSelected(this.getSelectedEntities(), true, selectionChanged, multiSelect)
	}

	_entitySelected(entity: T, addToSelection: boolean) {
		if (addToSelection) {
			if (this._selectedEntities.indexOf(entity) == -1) {
				this._selectedEntities.push(entity)
				// the selected entities must be sorted the same way the loaded entities are sorted
				this._selectedEntities.sort(this._config.sortCompare)
				this._reposition()
				this._config.elementSelected(this.getSelectedEntities(), false, true, true)
			}
		} else {
			let selectionChanged = this._selectedEntities.length != 1 || this._selectedEntities[0] != entity
			if (selectionChanged) {
				this._selectedEntities = [entity];
				this._reposition()
			}
			this._config.elementSelected(this.getSelectedEntities(), false, selectionChanged, false)
		}
	}

	selectNext(shiftPressed: boolean) {
		if (shiftPressed && this._lastMultiSelectWasKeyUp == true && this._selectedEntities.length > 1) {
			// we have to remove the selection from the top
			this._selectedEntities.splice(0, 1)
			this._reposition()
			this._config.elementSelected(this.getSelectedEntities(), false, true, true)
			this._scrollToLoadedEntityAndSelect(this._selectedEntities[0], true)
		} else {
			this._lastMultiSelectWasKeyUp = false
			if (this._selectedEntities.length === 0 && this._loadedEntities.length > 0) {
				this._entitySelected(this._loadedEntities[0], shiftPressed)
			} else if (this._selectedEntities.length !== 0 && this._loadedEntities.length > 0) {
				let selectedIndex = this._loadedEntities.indexOf(last(this._selectedEntities))
				if (!shiftPressed && selectedIndex == this._loadedEntities.length - 1) {
					// select the last entity currently selected as multi selection. This is needed to avoid that elements can not be selected any more if all elements are multi selected
					selectedIndex--
				}
				if (selectedIndex !== this._loadedEntities.length - 1) {
					this._scrollToLoadedEntityAndSelect(this._loadedEntities[selectedIndex + 1], shiftPressed)
				}
			}
		}
	}

	selectPrevious(shiftPressed: boolean) {
		if (shiftPressed && this._lastMultiSelectWasKeyUp == false && this._selectedEntities.length > 1) {
			// we have to remove the selection from the bottom
			this._selectedEntities.splice(-1, 1)
			this._reposition()
			this._config.elementSelected(this.getSelectedEntities(), false, true, true)
			this._scrollToLoadedEntityAndSelect(last(this._selectedEntities), true)
		} else {
			this._lastMultiSelectWasKeyUp = true
			if (this._selectedEntities.length === 0 && this._loadedEntities.length > 0) {
				this._entitySelected(this._loadedEntities[0], shiftPressed)
			} else if (this._selectedEntities.length !== 0 && this._loadedEntities.length > 0) {
				let selectedIndex = this._loadedEntities.indexOf(this._selectedEntities[0])
				if (!shiftPressed && selectedIndex == 0) {
					// select the first entity currently selected as multi selection. This is needed to avoid that elements can not be selected any more if all elements are multi selected
					selectedIndex++
				}
				if (selectedIndex !== 0) {
					this._scrollToLoadedEntityAndSelect(this._loadedEntities[selectedIndex - 1], shiftPressed)
				}
			}
		}
	}

	isEntitySelected(id: Id) {
		return this._selectedEntities.find(entity => getLetId(entity)[1] == id) != null
	}

	getSelectedEntities(): T[] {
		// return a copy to avoid outside modifications
		return this._selectedEntities.slice()
	}

	/**
	 * Must be called after creating the list. Loads an initial amount of elements into the list.
	 * @param listElementId If not null and existing, loads the list at least up to this element, scrolls to it and selects it.
	 */
	loadInitial(listElementId: ?Id): Promise<void> {
		if (listElementId) {
			return this.scrollToIdAndSelect(listElementId).then((entity) => {
				if (!entity) {
					return this._loadMore().then(() => {
						return this._domInitialized.promise.then(() => {
							this._domList.style.height = this._calculateListHeight()
						})
					})
				}
			})
		} else {
			return this._loadMore().then(() => {
				return this._domInitialized.promise.then(() => {
					this._domList.style.height = this._calculateListHeight()
				})
			})
		}
	}

	_loadMore(): Promise<*> {
		let start = this._loadedEntities.length
		let startId
		if (this._loadedEntities.length === 0) {
			startId = GENERATED_MAX_ID
		} else {
			startId = getLetId(this._loadedEntities[this._loadedEntities.length - 1])[1]
		}

		let count = PageSize
		this._loading = this._config.fetch(startId, count).then((newItems: T[]) => {
			if (newItems.length < count) this.setLoadedCompletely()
			for (let i = 0; i < newItems.length; i++) {
				this._loadedEntities[start + i] = newItems[i]
			}
			this._loadedEntities.sort(this._config.sortCompare)
		}).finally(() => {
			if (this.ready) {
				this._reposition()
			}
		})
		return this._loading
	}


	_calculateListHeight() {
		return this._config.rowHeight * (this._loadedEntities.length + (this._loadedCompletely ? 0 : 1)) + "px"
	}

	setLoadedCompletely() {
		this._loadedCompletely = true
		this._domInitialized.promise.then(() => {
			this._domLoadingRow.style.display = 'none'
		})
	}

	/**
	 *  updates the virtual elements that belong to the list entries between start and start + count
	 */
	// not used currently
	// updateVirtualRows(start: number, count: number) {
	//     let rowHeight = this._config.rowHeight
	//     for (let ve of this._virtualList) {
	//         let position = ve.top / rowHeight
	//         if (start <= position && position < start + count) {
	//             ve.update(this._getListElement(position), this.isEntitySelected(this._getListElement(position)))
	//         }
	//     }
	// }

	/**
	 * retrieves a new page from the server, if the element is currently not initialized
	 */
	_getListElement(index: number): T {
		let e = this._loadedEntities[index]
		if (e === undefined) {
			//this._loadMore(index)
		}
		return e
	}

	_init(domElement: HTMLElement) {
		this._domListContainer = domElement

		this._width = this._domListContainer.clientWidth
		this._domListContainer.addEventListener('scroll', (e) => {
			this.currentPosition = this._domListContainer.scrollTop
			if (this.lastPosition !== this.currentPosition) {
				window.requestAnimationFrame(() => this._scroll())
			}
		}, client.passive() ? {passive: true} : false)
		this._createVirtualElements()
		window.requestAnimationFrame(() => {
			m.redraw()
			window.requestAnimationFrame(() => {
				this._domInitialized.resolve()
				this._domList.style.height = this._calculateListHeight()
				this._reposition()
				this.ready = true
				if (client.isMobileDevice()) {
					new SwipeHandler(this._domListContainer, this)
					this.initBackground()
				}
			})
		})
	}

	_setDomList(domElement: HTMLElement) {
		this._domList = domElement
	}

	_createVirtualElements() {
		let visibleElements = 2 * Math.ceil((this._domListContainer.clientHeight / this._config.rowHeight) / 2) // divide and multiply by two to get an even number (because of alternating row backgrounds)
		this._virtualList.length = visibleElements + (ScrollBuffer * 2)
		this._visibleElementsHeight = visibleElements * this._config.rowHeight
		for (let i = 0; i < this._virtualList.length; i++) {
			this._virtualList[i] = this._config.createVirtualRow()
			this._virtualList[i].top = i * this._config.rowHeight
		}
	}

	_scroll() {
		let up = this.currentPosition < this.lastPosition ? true : false
		let scrollDiff = up ? this.lastPosition - this.currentPosition : this.currentPosition - this.lastPosition

		let now = window.performance.now()
		let timeDiff = Math.round(now - this.lastUpdateTime)
		this.lastUpdateTime = now

		let rowHeight = this._config.rowHeight

		let topElement = this._virtualList[0]
		let bottomElement = this._virtualList[this._virtualList.length - 1]

		let lastBunchVisible = this.currentPosition > (this._loadedEntities.length * this._config.rowHeight) - this._visibleElementsHeight * 2
		if (lastBunchVisible && (this._loading:any).isFulfilled() && !this._loadedCompletely) {
			this._loadMore().then(() => {
				this._domList.style.height = this._calculateListHeight()
			})
		}

		let status = {
			bufferUp: Math.floor((this.currentPosition - topElement.top) / rowHeight),
			bufferDown: Math.floor(((bottomElement.top + rowHeight) - (this.currentPosition + this._visibleElementsHeight)) / rowHeight),
			speed: Math.ceil(scrollDiff / timeDiff), // pixel per ms
			scrollDiff: scrollDiff,
			timeDiff: timeDiff
		}

		this.updateStatus(status)

		let start = timer(Cat.info)
		this.lastPosition = this.currentPosition
		if (this.updateLater) {
			// only happens for non desktop devices
			if (scrollDiff < 50 || this.currentPosition === 0 || this.currentPosition + this._visibleElementsHeight === this._loadedEntities.length * rowHeight) {
				// completely reposition the elements as scrolling becomes slower or the top / bottom of the list has been reached
				clearTimeout(this.repositionTimeout)
				this._reposition()
			}
		} else if (status.bufferDown <= 5 && (this.currentPosition + this._visibleElementsHeight) < (this._loadedEntities.length * rowHeight - 6 * rowHeight) ||
			status.bufferUp <= 5 && this.currentPosition > 6 * rowHeight) {
			if (client.isDesktopDevice()) {
				this._reposition()
			} else {
				log(Cat.debug, 'list > update later (scrolling too fast)')
				// scrolling is too fast, the buffer will be eaten up: stop painting until scrolling becomes slower
				this.updateLater = true
				this.repositionTimeout = setTimeout(() => this._repositionAfterScrollStop(), 110)
			}
		} else if (!up) {
			while ((topElement.top + rowHeight) < (this.currentPosition - this.bufferHeight)
			&& this._virtualList[this._virtualList.length - 1].top < (rowHeight * this._loadedEntities.length - rowHeight)) {
				let nextPosition = this._virtualList[this._virtualList.length - 1].top + rowHeight
				if (nextPosition < this.currentPosition) {
					this._reposition()
				} else {
					topElement.top = nextPosition
					if (topElement.domElement) topElement.domElement.style.transform = "translateY(" + topElement.top + "px)"
					let pos = topElement.top / rowHeight
					let entity = this._getListElement(pos)
					this._updateVirtualRow(topElement, entity, (pos % 2:any))
					this._virtualList.push(this._virtualList.shift())
					topElement = this._virtualList[0]
					bottomElement = topElement
				}
			}
		} else {
			while ((bottomElement.top) > (this.currentPosition + this._visibleElementsHeight + this.bufferHeight)
			&& topElement.top > 0) {
				let nextPosition = this._virtualList[0].top - rowHeight;
				if (nextPosition > this.currentPosition) {
					this._reposition()
				} else {
					bottomElement.top = nextPosition
					if (bottomElement.domElement) bottomElement.domElement.style.transform = "translateY(" + bottomElement.top + "px)"
					let pos = bottomElement.top / rowHeight
					let entity = this._getListElement(pos)
					this._updateVirtualRow(bottomElement, entity, (pos % 2:any))
					this._virtualList.unshift(this._virtualList.pop())
					topElement = bottomElement
					bottomElement = this._virtualList[this._virtualList.length - 1]
				}
			}
		}
	}

	_repositionAfterScrollStop() {
		if (window.performance.now() - this.lastUpdateTime > 100) {
			window.requestAnimationFrame(() => this._reposition())
		} else {
			this.repositionTimeout = setTimeout(() => this._repositionAfterScrollStop(), 110)
		}
	}

	_reposition() {
		this._emptyMessageBox.setVisible(this._loadedEntities.length == 0 && this._loadedCompletely && this._config.emptyMessage != "")

		this.currentPosition = this._domListContainer.scrollTop
		let rowHeight = this._config.rowHeight;
		let maxStartPosition = (rowHeight * this._loadedEntities.length) - this.bufferHeight * 2 - this._visibleElementsHeight
		let nextPosition = this.currentPosition - (this.currentPosition % rowHeight) - this.bufferHeight
		if (nextPosition < 0) {
			nextPosition = 0
		} else if (nextPosition > maxStartPosition) {
			nextPosition = maxStartPosition
		}
		for (let row of this._virtualList) {
			row.top = nextPosition
			nextPosition = nextPosition + rowHeight
			if (!row.domElement) {
				throw new Error("undefined dom element for virtual dom element", this._virtualList.length, row.top)
			}
			row.domElement.style.transform = "translateY(" + row.top + "px)"

			let pos = row.top / rowHeight
			let entity = this._getListElement(pos)
			this._updateVirtualRow(row, entity, (pos % 2:any))

		}
		if (this._loadedEntities.length % 2 == 0) {
			this._domLoadingRow.classList.add("odd-row")
		} else {
			this._domLoadingRow.classList.remove("odd-row")
		}

		log(Cat.debug, "repositioned list")
		this.updateLater = false
	}

	redraw(): void {
		this._reposition()
	}

	_updateVirtualRow(row: VirtualRow<T>, entity: T, odd: boolean) {
		row.entity = entity
		if (odd) {
			row.domElement.classList.remove('odd-row')
		} else {
			row.domElement.classList.add('odd-row')
		}
		if (entity) {
			row.domElement.style.display = 'list-item'
			row.update(entity, this.isEntitySelected(getLetId(entity)[1]))
		} else {
			row.domElement.style.display = 'none'
		}
	}

	updateStatus(status: {bufferUp: number, bufferDown: number, speed: number, scrollDiff: number, timeDiff: number}) {
		if (this._domStatus.bufferUp) this._domStatus.bufferUp.textContent = status.bufferUp + ''
		if (this._domStatus.bufferDown) this._domStatus.bufferDown.textContent = status.bufferDown + ''
		if (this._domStatus.speed) this._domStatus.speed.textContent = status.speed + ''
		if (this._domStatus.scrollDiff) this._domStatus.scrollDiff.textContent = status.scrollDiff + ''
		if (this._domStatus.timeDiff) this._domStatus.timeDiff.textContent = status.timeDiff + ''
	}


	initBackground() {
		let styles = [document.getElementById("css-main")].map(function (style) {
			return '<style>' + style.innerHTML + '</style>'
		})
		let height = this._virtualList.length * this._config.rowHeight
		let namespace = (document.documentElement.namespaceURI:any)
		let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + this._width + '" height="' + height + '">' +
			'<foreignObject width="100%" height="100%"><div xmlns="' + namespace + '">' + this._domListContainer.innerHTML + '</div>' + styles.join('') +
			'</foreignObject>' +
			'</svg>'
		let html = 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\r?\n|\r/g, ''))
		this._domList.style.backgroundImage = 'url("' + html + '")';
	}

	/**
	 * Selects the element with the given id and scrolls to it so it becomes visible.
	 * Immediately selects the element if it is already existing in the list, otherwise waits until it is received via websocket, then selects it.
	 */
	scrollToIdAndSelectWhenReceived(listElementId: Id): void {
		let entity = this.getEntity(listElementId)
		if (entity) {
			this._scrollToLoadedEntityAndSelect(entity, false)
		} else {
			this._idOfEntityToSelectWhenReceived = listElementId
		}
	}

	/**
	 * Selects the element with the given id and scrolls to it so it becomes visible. Loads the list until the given element is reached.
	 * @return The entity or null if the entity is not in this list.
	 */
	scrollToIdAndSelect(listElementId: Id): Promise<?T> {
		let entity = this.getEntity(listElementId)
		if (entity) {
			this._scrollToLoadedEntityAndSelect(entity, false)
			return Promise.resolve(entity)
		} else {
			// first check if the element can be loaded
			return this._config.loadSingle(listElementId).then((entity) => {
				if (!entity) {
					return null;
				}
				return this._loadTill(listElementId).then(scrollTarget => {
					return this._domInitialized.promise.then(() => {
						this._domList.style.height = this._calculateListHeight()
						if (scrollTarget != null) {
							this._scrollToLoadedEntityAndSelect(scrollTarget, false)
						}
						return scrollTarget
					})
				})
			})
		}
	}

	_scrollToLoadedEntityAndSelect(scrollTarget: T, addToSelection: boolean) {
		// check if the element is visible already. only scroll if it is not visible
		for (let i = 0; i < this._virtualList.length; i++) {
			if (this._virtualList[i].entity == scrollTarget) {
				if (this._virtualList[i].top - this.currentPosition > 0 && this._virtualList[i].top - this.currentPosition < this._visibleElementsHeight - this._config.rowHeight) {
					this._entitySelected(scrollTarget, addToSelection)
					// we do not need to scroll
					return
				}
				break;
			}
		}
		this._domListContainer.scrollTop = this._loadedEntities.indexOf(scrollTarget) * this._config.rowHeight
		this._entitySelected(scrollTarget, addToSelection)
	}

	_loadTill(listElementId: Id): Promise<?T> {
		let scrollTarget = this._loadedEntities.find(e => getLetId(e)[1] == listElementId)
		// also stop loading if the list element id is bigger than the loaded ones
		if (scrollTarget != null || this._loadedCompletely || (this._loadedEntities.length > 0 && firstBiggerThanSecond(listElementId, getLetId(this._loadedEntities[this._loadedEntities.length - 1])[1]))) {
			return Promise.resolve(scrollTarget)
		} else {
			return this._loadMore().then(() => this._loadTill(listElementId))
		}
	}

	entityEventReceived(elementId: Id, operation: OperationTypeEnum): Promise<void> {
		if (operation == OperationType.CREATE || operation == OperationType.UPDATE) {
			// load the element without range checks for now
			return this._config.loadSingle(elementId).then((entity) => {
				if (!entity) {
					return
				}
				let newEntity: T = neverNull(entity)
				// wait for any pending loading
				return this._loading.then(() => {
					if (operation == OperationType.CREATE) {
						if (this._loadedCompletely) {
							this._addToLoadedEntities(newEntity)
						} else if (this._loadedEntities.length > 0 && this._config.sortCompare(newEntity, last(this._loadedEntities)) < 0) {
							// new element is in the loaded range or newer than the first element
							this._addToLoadedEntities(newEntity)
						}
					} else if (operation == OperationType.UPDATE) {
						this._updateLoadedEntity(newEntity)
					}
				})
			})
		} else if (operation == OperationType.DELETE) {
			return this._deleteLoadedEntity(elementId);
		} else {
			return Promise.resolve()
		}
	}

	_addToLoadedEntities(entity: T) {
		for (let i = 0; i < this._loadedEntities.length; i++) {
			if (getLetId(entity)[1] === getLetId(this._loadedEntities[i])[1]) {
				console.log("entity already in list", entity);
				return;
			}
		}
		this._loadedEntities.push(entity);
		this._loadedEntities.sort(this._config.sortCompare)
		if (this.ready) {
			this._domList.style.height = this._calculateListHeight()
			this._reposition()
		}
		if (this._idOfEntityToSelectWhenReceived && this._idOfEntityToSelectWhenReceived == getLetId(entity)[1]) {
			this._idOfEntityToSelectWhenReceived = null
			this._scrollToLoadedEntityAndSelect(entity, false)
		}
	}

	_updateLoadedEntity(entity: T) {
		for (let positionToUpdate = 0; positionToUpdate < this._loadedEntities.length; positionToUpdate++) {
			if (getLetId(entity)[1] == getLetId(this._loadedEntities[positionToUpdate])[1]) {
				this._loadedEntities.splice(positionToUpdate, 1, (entity:any));
				this._loadedEntities.sort(this._config.sortCompare)
				if (this.ready) {
					this._reposition()
				}
				break;
			}
		}
		for (let i = 0; i < this._selectedEntities.length; i++) {
			if (getLetId(entity)[1] == getLetId(this._selectedEntities[i])[1]) {
				this._selectedEntities[i] = entity
				break;
			}
		}
	}

	_deleteLoadedEntity(elementId: Id): Promise<void> {
		// wait for any pending loading
		return this._loading.then(() => {
			let entity = this._loadedEntities.find(e => {
				return getLetId(e)[1] == elementId
			})
			if (entity) {
				let nextElementSelected = false
				if (this._selectedEntities.length === 1 && this._selectedEntities[0] == entity && this._loadedEntities.length > 1) {
					let nextSelection = (entity == last(this._loadedEntities)) ? this._loadedEntities[this._loadedEntities.length - 2] : this._loadedEntities[this._loadedEntities.indexOf(entity) + 1]
					this._selectedEntities.push(nextSelection)
					nextElementSelected = true
				}
				remove(this._loadedEntities, entity)
				let selectionChanged = remove(this._selectedEntities, entity)
				if (this.ready) {
					this._domList.style.height = this._calculateListHeight()
					this._reposition()
				}
				if (selectionChanged) {
					this._config.elementSelected(this.getSelectedEntities(), false, true, !nextElementSelected)
				}
			}
		})
	}
}

const ActionDistance = 150
class SwipeHandler {
	startPos: {x:number, y:number};
	virtualElement: ?VirtualRow<*>;
	list: List<*, *>;
	xoffset: number;
	touchArea: HTMLElement;

	constructor(touchArea: HTMLElement, list: List<*, *>) {
		if (!this.isSupported()) return
		this.startPos = {x: 0, y: 0}
		this.list = list
		this.xoffset = 0
		this.touchArea = touchArea
		let eventListenerArgs = client.passive() ? {passive: true} : false
		this.touchArea.addEventListener('touchstart', (e: TouchEvent) => this.start(e), eventListenerArgs)
		this.touchArea.addEventListener('touchmove', (e: TouchEvent) => this.move(e)) // does invoke prevent default
		this.touchArea.addEventListener('touchend', (e: TouchEvent) => this.end(e), eventListenerArgs)
		this.touchArea.addEventListener('touchcancel', (e: TouchEvent) => this.cancel(e), eventListenerArgs)
	}

	start(e: TouchEvent) {
		this.startPos.x = e.touches[0].clientX
		this.startPos.y = e.touches[0].clientY
	}

	move(e: TouchEvent) {
		let delta = this.getDelta(e)
		if (Math.abs(delta.y) > 40) {
			window.requestAnimationFrame(() => this.reset())
		} else if (Math.abs(delta.x) > 10 && Math.abs(delta.x) > Math.abs(delta.y)) {
			e.preventDefault() // stop list scrolling when we are swiping
			window.requestAnimationFrame(() => {
				// Do not animate the swipe gesture more than necessary
				this.xoffset = delta.x < 0 ? Math.max(delta.x, -ActionDistance) : Math.min(delta.x, ActionDistance)

				let ve = this.getVirtualElement()
				if (ve && ve.domElement && ve.entity) {
					ve.domElement.style.transform = 'translateX(' + this.xoffset + 'px) translateY(' + ve.top + 'px)'
					this.list._domSwipeSpacerLeft.style.transform = 'translateX(' + (this.xoffset - this.list._width) + 'px) translateY(' + ve.top + 'px)'
					this.list._domSwipeSpacerRight.style.transform = 'translateX(' + (this.xoffset + this.list._width) + 'px) translateY(' + ve.top + 'px)'
				}
			})
		}
	}

	end(e: TouchEvent) {
		let delta = this.getDelta(e)
		if (this.virtualElement && this.virtualElement.entity && Math.abs(delta.x) > ActionDistance && Math.abs(delta.y) < neverNull(this.virtualElement).domElement.offsetHeight) {
			let swipePromise
			if (delta.x < 0) {
				swipePromise = this.list._config.swipe.swipeLeft(neverNull(this.virtualElement).entity)
			} else {
				swipePromise = this.list._config.swipe.swipeRight(neverNull(this.virtualElement).entity)
			}
			this.finish()
			swipePromise.catch(() => this.list.redraw())
		} else {
			this.reset()
		}
	}

	finish() {
		if (this.xoffset !== 0) {
			let ve = neverNull(this.virtualElement)
			let listTargetPosition = (this.xoffset < 0) ? -(this.list._width) : (this.list._width)
			Promise.all([
				animations.add(ve.domElement, transform(transform.type.translateX, this.xoffset, listTargetPosition).chain(transform.type.translateY, ve.top, ve.top), {
					easing: ease.inOut,
					duration: DefaultAnimationTime * 2
				}),
				animations.add(this.list._domSwipeSpacerLeft, transform(transform.type.translateX, (this.xoffset - this.list._width), listTargetPosition - this.list._width).chain(transform.type.translateY, ve.top, ve.top), {
					easing: ease.inOut,
					duration: DefaultAnimationTime * 2
				}),
				animations.add(this.list._domSwipeSpacerRight, transform(transform.type.translateX, (this.xoffset + this.list._width), listTargetPosition + this.list._width).chain(transform.type.translateY, ve.top, ve.top), {
					easing: ease.inOut,
					duration: DefaultAnimationTime * 2
				})
			]).then(() => {
				this.xoffset = 0
				ve.domElement.style.transform = 'translateX(' + this.xoffset + 'px) translateY(' + ve.top + 'px)'
				return Promise.all([
					animations.add(this.list._domSwipeSpacerLeft, opacity(1, 0, true)),
					animations.add(this.list._domSwipeSpacerRight, opacity(1, 0, true))
				])
			}).then(() => {
				this.list._domSwipeSpacerLeft.style.transform = 'translateX(' + (this.xoffset - this.list._width) + 'px) translateY(' + ve.top + 'px)'
				this.list._domSwipeSpacerRight.style.transform = 'translateX(' + (this.xoffset + this.list._width) + 'px) translateY(' + ve.top + 'px)'
				this.list._domSwipeSpacerRight.style.opacity = ''
				this.list._domSwipeSpacerLeft.style.opacity = ''
			})
		}
		this.virtualElement = null
	}


	reset() {
		if (this.xoffset !== 0) {
			let ve = this.virtualElement
			if (ve && ve.domElement && ve.entity) {
				animations.add(ve.domElement, transform(transform.type.translateX, this.xoffset, 0).chain(transform.type.translateY, ve.top, ve.top), {easing: ease.inOut})
				animations.add(this.list._domSwipeSpacerLeft, transform(transform.type.translateX, (this.xoffset - this.list._width), -this.list._width).chain(transform.type.translateY, ve.top, ve.top), {easing: ease.inOut})
				animations.add(this.list._domSwipeSpacerRight, transform(transform.type.translateX, (this.xoffset + this.list._width), this.list._width).chain(transform.type.translateY, ve.top, ve.top), {easing: ease.inOut})
			}
			this.xoffset = 0
		}
		this.virtualElement = null
	}

	getVirtualElement(): VirtualElement {
		if (!this.virtualElement) {
			let touchAreaOffset = this.touchArea.getBoundingClientRect().top
			let relativeYposition = this.list.currentPosition + this.startPos.y - touchAreaOffset
			let targetElementPosition = Math.floor(relativeYposition / this.list._config.rowHeight) * this.list._config.rowHeight
			this.virtualElement = this.list._virtualList.find(ve => ve.top === targetElementPosition)
		}
		return (this.virtualElement:any)
	}

	getDelta(e: any) {
		return {
			x: e.changedTouches[0].clientX - this.startPos.x,
			y: e.changedTouches[0].clientY - this.startPos.y
		}
	}

	cancel(e: TouchEvent) {
		this.reset()
	}

	isSupported() {
		return 'ontouchstart' in window
	}
}


export function sortCompareByReverseId(entity1: Object, entity2: Object) {
	if (entity1._id[1] == entity2._id[1]) {
		return 0
	} else {
		return firstBiggerThanSecond(entity1._id[1], entity2._id[1]) ? -1 : 1
	}
}

export function sortCompareById(entity1: Object, entity2: Object) {
	if (entity1._id[1] == entity2._id[1]) {
		return 0
	} else {
		return firstBiggerThanSecond(entity1._id[1], entity2._id[1]) ? 1 : -1
	}
}