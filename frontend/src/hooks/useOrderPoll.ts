/**
 * Hook: poll an order by id until it reaches a terminal state.
 * Uses react-query's refetchInterval to auto-stop at terminal states.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { isTerminal } from "../types";

export function useOrderPoll(orderId: string | undefined) {
  return useQuery({
    queryKey: ["order", orderId],
    queryFn: () => api.getOrder(orderId!),
    enabled: !!orderId,
    refetchInterval: (query) => {
      const order = query.state.data;
      if (order && isTerminal(order.status)) return false;
      return 3000;
    },
  });
}
