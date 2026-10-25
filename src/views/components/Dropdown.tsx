import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as mobxReact from 'mobx-react-lite';
import * as PopperJS from '@popperjs/core';

export interface DropdownLabelProps {
  ref: (ref: HTMLElement | null) => void;
  expanded: boolean;
  toggle: () => void;
}

export interface DropdownPopperProps {
  toggle: () => void;
  labelElement: HTMLElement | null;
}

export interface DropdownProps {
  label: React.FunctionComponent<DropdownLabelProps>;
  popper: React.FunctionComponent<DropdownPopperProps>;
  placement: PopperJS.Placement;
  modifiers?: PopperJS.StrictModifiers[];
  strategy?: PopperJS.PositioningStrategy;
  keepMounted?: boolean;
}

export const Dropdown = mobxReact.observer<DropdownProps>(props => {
  const [ opened, setOpened ] = React.useState(false);
  const [ expanded, setExpanded ] = React.useState(false);
  const [ labelElement, setLabelElement ] = React.useState<HTMLElement | null>(null);
  const toggle = React.useCallback((e?: UIEvent) => {
    setOpened(true);
    setExpanded(expanded => !expanded);
    if (e) {
      e.stopPropagation();
    }
  }, []);
  return (
    <>
      {props.label({
        ref: setLabelElement,
        expanded,
        toggle,
      })}
      {(expanded || (props.keepMounted && opened)) && (
        <DropdownPopper
          {...props}
          expanded={expanded}
          setExpanded={setExpanded}
          labelElement={labelElement}
          toggle={toggle}
        />
      )}
    </>
  );
});

const DropdownPopper = mobxReact.observer<DropdownProps & {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  labelElement: HTMLElement | null;
  toggle: () => void;
}>(props => {
  const { popper, placement, modifiers=[], strategy='absolute', expanded, setExpanded, labelElement, toggle } = props;
  const [ popperOptions ] = React.useState({ placement, modifiers, strategy });
  const [ popperElement, setPopperElement ] = React.useState<HTMLElement | null>(null);
  const popperContainer = document.getElementById('popper');
  React.useLayoutEffect(() => {
    if (!expanded || labelElement === null || popperElement === null) return;
    const options = {
      ...popperOptions,
      modifiers: popperOptions.strategy === 'fixed' ? popperOptions.modifiers : [
        ...popperOptions.modifiers,
        { name: 'flip', options: { padding: { bottom: 50 } }},
      ],
    };
    const popperInstance = PopperJS.createPopper(labelElement, popperElement, options);
    if (popperOptions.strategy === 'fixed') {
      popperElement.style.zIndex = '7';  // for search: z-index: 7;
    }
    return () => popperInstance.destroy();
  }, [expanded, labelElement, popperElement, popperOptions]);
  React.useEffect(() => {
    if (!expanded) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target && labelElement && popperElement) {
        if (!labelElement.contains(target) && !popperElement.contains(target)) {
          setExpanded(false);
          onGlobalClick = undefined;
          (e as any)._isClosingDropdown = true;
        }
      }
    };
    const handleKeyup = (e: KeyboardEvent) => {
      const target = e.target as Element;
      // label (比如是一个 button) 有可能成为按键事件的 target
      if (target && (target.tagName === 'BODY' || target === labelElement) && e.key === 'Escape') {
        setExpanded(false);
        onGlobalKeyup = undefined;
      }
    };
    onGlobalClick = handleClick;
    onGlobalKeyup = handleKeyup;
    return () => {
      if (onGlobalClick === handleClick) onGlobalClick = undefined;
      if (onGlobalKeyup === handleKeyup) onGlobalKeyup = undefined;
    };
  }, [expanded, labelElement, popperElement, setExpanded]);
  return popperContainer && ReactDOM.createPortal((
    <div
      ref={setPopperElement}
      style={{ display: expanded ? undefined : 'none' }}
      aria-hidden={!expanded}
      onClick={e => e.stopPropagation()}
      children={React.createElement(popper, { toggle, labelElement })}
    />
  ), popperContainer);
});

let onGlobalClick: ((e: MouseEvent) => void) | undefined;
window.addEventListener('click', e => onGlobalClick?.(e), true);
let onGlobalKeyup: ((e: KeyboardEvent) => void) | undefined;
window.addEventListener('keyup', e => onGlobalKeyup?.(e), true);
