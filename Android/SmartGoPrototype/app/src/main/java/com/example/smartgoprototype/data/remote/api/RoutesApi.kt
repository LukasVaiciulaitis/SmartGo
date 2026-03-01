package com.example.smartgoprototype.data.remote.api

import com.example.smartgoprototype.data.remote.dto.CreateRouteRequest
import com.example.smartgoprototype.data.remote.dto.CreateRouteResponseDto
import com.example.smartgoprototype.data.remote.dto.DeleteRouteRequestDto
import com.example.smartgoprototype.data.remote.dto.DeleteRouteResponseDto
import com.example.smartgoprototype.data.remote.dto.FetchRoutesResponseDto
import com.example.smartgoprototype.data.remote.dto.UpdateRouteRequestDto
import com.example.smartgoprototype.data.remote.dto.UpdateRouteResponseDto
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.HTTP
import retrofit2.http.POST
import retrofit2.http.PUT

/**
 * Retrofit contract for the Routes backend.
 *
 * - Mapping from DTOs to domain models happens in the repository layer
 *   keeping the UI/ViewModel independent of network schemas.
 */
interface RoutesApi {

    /**
     * Fetches the current user's saved routes.
     *
     */
    @GET("routes/fetch")
    suspend fun getRoutes(): FetchRoutesResponseDto

    /**
     * Creates a new route.
     *
     */
    @POST("routes/create")
    suspend fun createRoute(
        @Body request: CreateRouteRequest
    ): CreateRouteResponseDto

    @PUT("routes/update")
    suspend fun updateRoute(
        @Body request: UpdateRouteRequestDto
    ): UpdateRouteResponseDto

    @HTTP(method = "DELETE", path = "routes/delete", hasBody = true)
    suspend fun deleteRoute(
        @Body request: DeleteRouteRequestDto
    ): DeleteRouteResponseDto
}
