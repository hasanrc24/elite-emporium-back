declare namespace Express {
  export interface Request {
    id: string;
    auth?: any;
    cart?: any;
    wishlist?: any;
  }
}
