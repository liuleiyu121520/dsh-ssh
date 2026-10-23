/** FitAddon 测试替身：记录 fit() 调用次数。 */
export class FitAddon {
  constructor() {
    this.fits = 0;
  }

  fit() {
    this.fits += 1;
  }
}

export default { FitAddon };
