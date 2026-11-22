import { describe, it, expect } from 'vitest';
import { HubHostIcon } from './HubHostIcon.js';
import { RemoteHostIcon } from './RemoteHostIcon.js';

describe('HubHostIcon', () => {
  it('renders standard attributes and element structure', () => {
    const icon = HubHostIcon({});
    expect(icon).toBeDefined();
    expect(icon.props.className).toBe('host-icon host-icon--hub');
    expect(icon.props.viewBox).toBe('0 0 16 16');
    expect(icon.props.width).toBe(14);
    expect(icon.props.height).toBe(14);
    expect(icon.props.fill).toBe('none');
    expect(icon.props['aria-hidden']).toBe(true);

    const children = icon.props.children;
    expect(children).toHaveLength(3);

    const [screenRect, standPath, promptPath] = children;

    // Monitor screen frame
    expect(screenRect.type).toBe('rect');
    expect(screenRect.props.x).toBe(1.5);
    expect(screenRect.props.y).toBe(2);
    expect(screenRect.props.width).toBe(13);
    expect(screenRect.props.height).toBe(9);
    expect(screenRect.props.rx).toBe(1.5);
    expect(screenRect.props.fill).toBe('currentColor');
    expect(screenRect.props.fillOpacity).toBe(0.12);
    expect(screenRect.props.stroke).toBe('currentColor');
    expect(screenRect.props.strokeWidth).toBe(1.2);
    expect(screenRect.props.strokeLinejoin).toBe('round');

    // Stand neck and base
    expect(standPath.type).toBe('path');
    expect(standPath.props.d).toBe('M8 11V13.5M4.5 13.5H11.5');
    expect(standPath.props.stroke).toBe('currentColor');
    expect(standPath.props.strokeWidth).toBe(1.2);
    expect(standPath.props.strokeLinecap).toBe('round');
    expect(standPath.props.strokeLinejoin).toBe('round');

    // Terminal prompt inside screen
    expect(promptPath.type).toBe('path');
    expect(promptPath.props.d).toBe('M4.5 5L6.5 6.5L4.5 8M8.5 8H11');
    expect(promptPath.props.stroke).toBe('currentColor');
    expect(promptPath.props.strokeWidth).toBe(1.2);
    expect(promptPath.props.strokeLinecap).toBe('round');
    expect(promptPath.props.strokeLinejoin).toBe('round');
  });

  it('accepts custom className, dimensions, and style', () => {
    const custom = HubHostIcon({
      className: 'custom-hub-icon',
      width: 20,
      height: 20,
      style: { opacity: 0.85, margin: '2px' },
    });
    expect(custom.props.className).toBe('custom-hub-icon');
    expect(custom.props.width).toBe(20);
    expect(custom.props.height).toBe(20);
    expect(custom.props.style).toMatchObject({
      flexShrink: 0,
      opacity: 0.85,
      margin: '2px',
    });
  });
});

describe('RemoteHostIcon', () => {
  it('renders standard attributes and element structure', () => {
    const icon = RemoteHostIcon({});
    expect(icon).toBeDefined();
    expect(icon.props.className).toBe('host-icon host-icon--remote');
    expect(icon.props.viewBox).toBe('0 0 16 16');
    expect(icon.props.width).toBe(14);
    expect(icon.props.height).toBe(14);
    expect(icon.props.fill).toBe('none');
    expect(icon.props['aria-hidden']).toBe(true);

    const children = icon.props.children;
    expect(children).toHaveLength(6);

    const [leftWing, rightWing, bodyChassis, gridLines, antennaPath, downlinkPath] = children;

    // Solar wings
    expect(leftWing.type).toBe('rect');
    expect(leftWing.props.x).toBe(1.5);
    expect(leftWing.props.y).toBe(5);
    expect(leftWing.props.width).toBe(3.5);
    expect(leftWing.props.height).toBe(6);
    expect(leftWing.props.rx).toBe(0.8);
    expect(leftWing.props.fill).toBe('currentColor');
    expect(leftWing.props.fillOpacity).toBe(0.12);
    expect(leftWing.props.stroke).toBe('currentColor');
    expect(leftWing.props.strokeWidth).toBe(1.2);

    expect(rightWing.type).toBe('rect');
    expect(rightWing.props.x).toBe(11);
    expect(rightWing.props.y).toBe(5);
    expect(rightWing.props.width).toBe(3.5);
    expect(rightWing.props.height).toBe(6);
    expect(rightWing.props.rx).toBe(0.8);
    expect(rightWing.props.fill).toBe('currentColor');
    expect(rightWing.props.fillOpacity).toBe(0.12);
    expect(rightWing.props.stroke).toBe('currentColor');
    expect(rightWing.props.strokeWidth).toBe(1.2);

    // Central chassis
    expect(bodyChassis.type).toBe('rect');
    expect(bodyChassis.props.x).toBe(6);
    expect(bodyChassis.props.y).toBe(4.5);
    expect(bodyChassis.props.width).toBe(4);
    expect(bodyChassis.props.height).toBe(7);
    expect(bodyChassis.props.rx).toBe(1);
    expect(bodyChassis.props.fill).toBe('currentColor');
    expect(bodyChassis.props.fillOpacity).toBe(0.18);
    expect(bodyChassis.props.stroke).toBe('currentColor');
    expect(bodyChassis.props.strokeWidth).toBe(1.2);

    // Solar grid & struts
    expect(gridLines.type).toBe('path');
    expect(gridLines.props.d).toBe('M1.5 8H6M10 8H14.5');
    expect(gridLines.props.stroke).toBe('currentColor');
    expect(gridLines.props.strokeWidth).toBe(1.2);
    expect(gridLines.props.strokeLinecap).toBe('round');

    // Antenna & dish
    expect(antennaPath.type).toBe('path');
    expect(antennaPath.props.d).toBe('M8 4.5V2.5M5.5 2.5A3 3 0 0 1 10.5 2.5');
    expect(antennaPath.props.stroke).toBe('currentColor');
    expect(antennaPath.props.strokeWidth).toBe(1.2);
    expect(antennaPath.props.strokeLinecap).toBe('round');

    // Downlink probe & wave
    expect(downlinkPath.type).toBe('path');
    expect(downlinkPath.props.d).toBe('M8 11.5V13M6 13.8C6.8 14.8 9.2 14.8 10 13.8');
    expect(downlinkPath.props.stroke).toBe('currentColor');
    expect(downlinkPath.props.strokeWidth).toBe(1.2);
    expect(downlinkPath.props.strokeLinecap).toBe('round');
  });

  it('accepts custom className, dimensions, and style', () => {
    const custom = RemoteHostIcon({
      className: 'custom-remote-icon',
      width: 18,
      height: 18,
      style: { opacity: 0.9, transform: 'scale(1.1)' },
    });
    expect(custom.props.className).toBe('custom-remote-icon');
    expect(custom.props.width).toBe(18);
    expect(custom.props.height).toBe(18);
    expect(custom.props.style).toMatchObject({
      flexShrink: 0,
      opacity: 0.9,
      transform: 'scale(1.1)',
    });
  });

  it('correctly selects host icon component based on group key', () => {
    const getHostIconComponent = (key: string) => (key === 'hub' ? HubHostIcon : RemoteHostIcon);

    expect(getHostIconComponent('hub')).toBe(HubHostIcon);
    expect(getHostIconComponent('remote-node-1')).toBe(RemoteHostIcon);
    expect(getHostIconComponent('satellite-worker')).toBe(RemoteHostIcon);
  });
});
